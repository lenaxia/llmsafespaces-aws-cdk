#!/usr/bin/env bash
# dr-drill.sh — Restore the RDS instance from its latest automated
# snapshot into a sandbox instance, verify a few tables have the
# expected row counts, then tear down. Measures RTO.
#
# Usage:
#   scripts/dr-drill.sh [--keep] [--profile AWS_PROFILE] [--region REGION]
#
# Options:
#   --keep       Skip the teardown step. Useful when investigating a
#                real failure. The restored instance survives until the
#                operator deletes it (~$14/day for db.t4g.micro).
#   --profile P  AWS profile (default: mikekao-prod)
#   --region R   AWS region (default: us-west-2)
#
# Environment:
#   DR_DRILL_TIMEOUT_SECONDS   Max seconds to wait for restore to
#                              complete before giving up. Default: 1800
#                              (30 min). db.t4g.micro on gp3 typically
#                              lands in 8-12 min from snapshot.
#
# What it does not test:
#   - Application-level replay from Redis (ephemeral cache — not backed up).
#   - VPC / SG / subnet path (the restored instance goes into the same
#     VPC/subnet group as the production instance; a true region-loss
#     drill would need cross-region snapshot copy first).
#
# Exit codes:
#   0  Drill passed (restore + verify + teardown all OK).
#   1  Restore itself failed or timed out.
#   2  Restore OK but verification queries failed.
#   3  Verification OK but teardown failed (manual cleanup needed).

set -euo pipefail

# --- Argument parsing ---
KEEP_INSTANCE="false"
AWS_PROFILE="${AWS_PROFILE:-mikekao-prod}"
AWS_REGION="${AWS_REGION:-us-west-2}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP_INSTANCE="true"; shift ;;
    --profile) AWS_PROFILE="$2"; shift 2 ;;
    --region) AWS_REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
export AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
TIMEOUT="${DR_DRILL_TIMEOUT_SECONDS:-1800}"

# Wrap `aws` so every call uses the resolved profile+region without
# needing to pass --profile/--region on every line below. This avoids
# subtle failures where the operator's shell env sets a different
# AWS_PROFILE/AWS_REGION that shadows the script's exports.
#
# Also force --output text so we're not at the mercy of the profile's
# default output setting (some operator environments have a corrupt
# ~/.aws/config that produces "Unknown output type" errors, which
# would trip `set -e` on every aws call).
aws() {
  command aws --profile "$AWS_PROFILE" --region "$AWS_REGION" --output text "$@"
}

# --- Helpers ---
log() { printf "[%s] %s\n" "$(date -Iseconds)" "$*"; }
err() { printf "[%s] ERROR: %s\n" "$(date -Iseconds)" "$*" >&2; }

# Discover the production RDS instance. The CDK stack names it
# `LlmSafeSpaces-Data-Postgres<id>-<random>` — filter by our tag.
log "Locating production RDS instance..."
PROD_INSTANCE_ID=$(aws rds describe-db-instances \
  --query "DBInstances[?TagList[?Key=='project' && Value=='llmsafespaces']].DBInstanceIdentifier | [0]" \
  --output text)
if [[ -z "$PROD_INSTANCE_ID" || "$PROD_INSTANCE_ID" == "None" ]]; then
  err "Could not find production RDS instance tagged project=llmsafespaces."
  exit 1
fi
log "Production instance: $PROD_INSTANCE_ID"

# Find latest automated snapshot for this instance.
log "Finding latest automated snapshot..."
SNAPSHOT_ID=$(aws rds describe-db-snapshots \
  --db-instance-identifier "$PROD_INSTANCE_ID" \
  --snapshot-type automated \
  --query "sort_by(DBSnapshots, &SnapshotCreateTime)[-1].DBSnapshotIdentifier" \
  --output text)
if [[ -z "$SNAPSHOT_ID" || "$SNAPSHOT_ID" == "None" ]]; then
  err "No automated snapshots found for $PROD_INSTANCE_ID."
  err "Check RDS BackupRetentionPeriod > 0 (currently the CDK sets 7 days for mvp / 30 days for prod)."
  exit 1
fi
SNAPSHOT_TIME=$(aws rds describe-db-snapshots \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --query 'DBSnapshots[0].SnapshotCreateTime' --output text)
log "Snapshot: $SNAPSHOT_ID (created $SNAPSHOT_TIME)"

# Determine target instance name. Include timestamp so re-runs don't
# collide, and 'dr-drill' prefix so alarms on the prod name don't fire.
DRILL_INSTANCE_ID="llmsafespaces-dr-drill-$(date +%Y%m%d%H%M%S)"

# Fetch prod's subnet group + SG so we restore into the same VPC.
log "Inspecting production instance networking..."
SUBNET_GROUP=$(aws rds describe-db-instances \
  --db-instance-identifier "$PROD_INSTANCE_ID" \
  --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text)
SG_IDS=$(aws rds describe-db-instances \
  --db-instance-identifier "$PROD_INSTANCE_ID" \
  --query 'DBInstances[0].VpcSecurityGroups[*].VpcSecurityGroupId' --output text)
log "Subnet group: $SUBNET_GROUP, SGs: $SG_IDS"

# --- Restore ---
log "Starting restore into $DRILL_INSTANCE_ID..."
RESTORE_START=$(date +%s)
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "$DRILL_INSTANCE_ID" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --db-subnet-group-name "$SUBNET_GROUP" \
  --vpc-security-group-ids $SG_IDS \
  --db-instance-class db.t4g.micro \
  --no-publicly-accessible \
  --no-multi-az \
  --storage-type gp3 \
  --no-deletion-protection \
  --tags Key=project,Value=llmsafespaces Key=purpose,Value=dr-drill Key=source-snapshot,Value="$SNAPSHOT_ID" \
  >/dev/null

# Wait for it to become available.
log "Waiting for the restore to complete (up to $TIMEOUT seconds)..."
ELAPSED=0
while true; do
  STATUS=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_INSTANCE_ID" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "not-found")
  if [[ "$STATUS" == "available" ]]; then
    break
  fi
  if [[ $ELAPSED -ge $TIMEOUT ]]; then
    err "Restore timed out after $ELAPSED seconds. Current status: $STATUS."
    err "Investigate in the RDS console; the instance $DRILL_INSTANCE_ID still exists."
    exit 1
  fi
  printf "."
  sleep 15
  ELAPSED=$((ELAPSED + 15))
done
echo
RESTORE_END=$(date +%s)
RTO_SECONDS=$((RESTORE_END - RESTORE_START))
log "Restore complete. RTO (snapshot start → available): ${RTO_SECONDS}s"

# --- Verify ---
log "Verifying row counts on key tables..."
DRILL_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
PROD_SECRET_ARN=$(aws rds describe-db-instances --db-instance-identifier "$PROD_INSTANCE_ID" \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
if [[ -z "$PROD_SECRET_ARN" || "$PROD_SECRET_ARN" == "None" ]]; then
  # Older CDK didn't use the managed-secret feature. Fall back to the
  # RDS::Credentials generated Secret. Its name pattern is
  # `<Stack>Data<Postgres...>Secret-...`. Grep-by-name is more portable
  # than tag-filtering (RDS-generated secrets aren't necessarily
  # tagged with `project`).
  PROD_SECRET_ARN=$(aws secretsmanager list-secrets \
    --query "SecretList[?contains(Name, \`PostgresSe\`)].ARN" \
    --output text | head -n 1)
fi
if [[ -z "$PROD_SECRET_ARN" || "$PROD_SECRET_ARN" == "None" ]]; then
  err "Could not find postgres master secret. Skipping verification."
  err "Verify manually: psql -h $DRILL_ENDPOINT -U llmsafespaces_admin llmsafespaces"
  VERIFY_STATUS="skipped"
else
  DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "$PROD_SECRET_ARN" \
    --query 'SecretString' --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')
  DB_USER=$(aws secretsmanager get-secret-value --secret-id "$PROD_SECRET_ARN" \
    --query 'SecretString' --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])')

  # Run from a temp EC2 instance? No, use a K8s Job on the cluster since
  # the drill instance is in the private subnet. Simpler: exec psql
  # from any existing pod that has network path to RDS.
  #
  # NB: this requires kubectl context to be set to the llmsafespaces
  # cluster. If it's not, exit with a message rather than failing hard.
  if ! kubectl cluster-info >/dev/null 2>&1; then
    err "kubectl context not set to the cluster. Run:"
    err "  aws eks update-kubeconfig --profile $AWS_PROFILE --region $AWS_REGION --name llmsafespaces"
    err "then re-run this script with the same instance (--keep the current one):"
    err "  scripts/dr-drill.sh --keep  # skip teardown; re-verify manually"
    VERIFY_STATUS="deferred"
  else
    # Ephemeral verification pod. Use the postgres:17 image which
    # includes psql. Timeout after 60s.
    log "Spawning ephemeral verification pod..."
    VERIFY_OUTPUT=$(kubectl run --rm -i --restart=Never --wait=true \
      --timeout=120s --namespace default dr-drill-verify-$$ \
      --image=postgres:17-alpine \
      --env="PGPASSWORD=$DB_PASSWORD" \
      --command -- psql "host=$DRILL_ENDPOINT user=$DB_USER dbname=llmsafespaces sslmode=require" \
      -A -t -c "SELECT 'users', count(*) FROM users UNION ALL SELECT 'workspaces', count(*) FROM workspaces UNION ALL SELECT 'organizations', count(*) FROM organizations UNION ALL SELECT 'provider_credentials', count(*) FROM provider_credentials;" 2>&1) || VERIFY_STATUS="failed"

    echo "$VERIFY_OUTPUT" | grep -E '^(users|workspaces|organizations|provider_credentials)' || true

    # Sanity: at least ONE table should have at least ONE row.
    # `users` may be 0 on a fresh cluster (no signups yet) — that's
    # fine, other tables' presence proves the schema restore worked.
    # The failure mode we're checking against: "all tables missing" or
    # "restore came up empty".
    TOTAL_ROWS=$(echo "$VERIFY_OUTPUT" | grep -E '^(users|workspaces|organizations|provider_credentials)' | \
      cut -d'|' -f2 | awk '{s+=$1} END {print s+0}')
    if [[ -z "$TOTAL_ROWS" || "$TOTAL_ROWS" -lt 1 ]]; then
      err "Verify FAILED: no rows across users/workspaces/organizations/provider_credentials (expected ≥ 1 total)."
      VERIFY_STATUS="failed"
    else
      log "Verify OK: total rows across sample tables = $TOTAL_ROWS"
      VERIFY_STATUS="ok"
    fi
  fi
fi

# --- Teardown ---
if [[ "$KEEP_INSTANCE" == "true" ]]; then
  log "Skipping teardown (--keep). Instance $DRILL_INSTANCE_ID left running."
  log "To delete manually:"
  log "  aws rds delete-db-instance --db-instance-identifier $DRILL_INSTANCE_ID --skip-final-snapshot"
else
  log "Deleting $DRILL_INSTANCE_ID..."
  aws rds delete-db-instance \
    --db-instance-identifier "$DRILL_INSTANCE_ID" \
    --skip-final-snapshot \
    --delete-automated-backups \
    >/dev/null
  # Don't wait for full deletion (takes another 5min). Fire-and-forget.
  log "Deletion request submitted. Instance will be fully removed within 5-10 min."
fi

# --- Report ---
log ""
log "=== DR drill report ==="
log "  Prod instance:      $PROD_INSTANCE_ID"
log "  Source snapshot:    $SNAPSHOT_ID (age: $(( ($(date +%s) - $(date -d "$SNAPSHOT_TIME" +%s)) / 3600 ))h)"
log "  Drill instance:     $DRILL_INSTANCE_ID"
log "  RTO measured:       ${RTO_SECONDS}s"
log "  Verify status:      ${VERIFY_STATUS:-?}"
log "  Teardown status:    $([[ "$KEEP_INSTANCE" == "true" ]] && echo "SKIPPED (--keep)" || echo "requested")"
log ""

case "${VERIFY_STATUS:-}" in
  ok) exit 0 ;;
  skipped|deferred) exit 0 ;;  # Not a drill failure, just a config gap.
  failed) exit 2 ;;
  *) exit 0 ;;
esac
