#!/usr/bin/env bash
# teardown.sh — uninstall the chart, clean up workarounds, and destroy CDK stacks.
#
# Usage:
#   AWS_PROFILE=mikekao-prod ./scripts/teardown.sh
#   AWS_PROFILE=mikekao-prod FORCE=1 ./scripts/teardown.sh    # skip prompt
#
# Env:
#   STAGE   CDK stage name. Default: LlmSafeSpaces.
#   FORCE   If 1, skip interactive confirmation.

set -euo pipefail

: "${AWS_PROFILE:?set AWS_PROFILE first}"
: "${AWS_REGION:=us-west-2}"

STAGE="${STAGE:-LlmSafeSpaces}"
FORCE="${FORCE:-0}"

log() { printf '[teardown] %s\n' "$*" >&2; }

if [[ "$FORCE" != "1" ]]; then
  read -rp "This will delete all data (RDS final snapshot taken; Valkey data is lost). Continue? [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]] || { log "aborted"; exit 1; }
fi

# Uninstall chart if present.
if helm status llmsafespaces -n llmsafespaces >/dev/null 2>&1; then
  log "uninstalling chart"
  helm uninstall llmsafespaces -n llmsafespaces || true
  kubectl -n llmsafespaces delete pvc --all --ignore-not-found --timeout=2m || true
fi

# Remove finalizers from any lingering workspace CRs before deleting
# the CRD itself. Without this, CRD delete hangs because the workspace
# controller (gone) can't reconcile the finalizer off.
log "force-removing finalizers from any lingering workspace CRs"
if kubectl get crd workspaces.llmsafespaces.dev >/dev/null 2>&1; then
  for ws in $(kubectl get workspaces.llmsafespaces.dev -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {end}' 2>/dev/null); do
    ns="${ws%/*}"
    name="${ws#*/}"
    [[ -z "$ns" || -z "$name" ]] && continue
    log "  patching $ns/$name"
    kubectl -n "$ns" patch workspace.llmsafespaces.dev "$name" \
      --type=json -p='[{"op":"remove","path":"/metadata/finalizers"}]' >/dev/null 2>&1 || true
  done
fi

log "deleting CRDs"
kubectl delete crd \
  workspaces.llmsafespaces.dev \
  runtimeenvironments.llmsafespaces.dev \
  inferencerelays.llmsafespaces.dev \
  --ignore-not-found --timeout=2m || true

log "cleaning workaround ClusterRole/Binding (issue lenaxia/LLMSafeSpaces#469)"
kubectl delete clusterrolebinding llmsafespaces-controller-cm --ignore-not-found || true
kubectl delete clusterrole llmsafespaces-controller-cm --ignore-not-found || true

# Destroy CDK stacks. With Stage pattern, --all alone matches nothing;
# we explicitly select the stage's stacks.
log "destroying CDK stacks '$STAGE/*' (~20 minutes)"
npx cdk destroy "${STAGE}/*" --force

log "done. Note: the ACM cert and Secrets Manager Secrets are retained by default."
log "      To remove the SM secrets:"
log "        aws secretsmanager list-secrets --filters Key=tag-value,Values=app-secret --region $AWS_REGION"
