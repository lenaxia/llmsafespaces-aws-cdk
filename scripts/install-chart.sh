#!/usr/bin/env bash
# install-chart.sh — install or upgrade the llmsafespaces Helm chart.
#
# Reads endpoints + cert ARN from the CDK stack outputs and writes the
# helm install command. The K8s `llmsafespaces-credentials` Secret is
# materialized by external-secrets-operator from Secrets Manager, so
# there's no manual `kubectl patch` step.
#
# Usage:
#   AWS_PROFILE=mikekao-prod ./scripts/install-chart.sh
#
# Env vars (optional):
#   CHART_PATH    Path to the chart. Default: clones lenaxia/LLMSafeSpaces.
#   STAGE         CDK stage name. Default: LlmSafeSpaces.
#   DRY_RUN       If set to 1, prints the helm command and exits.

set -euo pipefail

: "${AWS_PROFILE:?set AWS_PROFILE first}"
: "${AWS_REGION:=us-west-2}"

STAGE="${STAGE:-LlmSafeSpaces}"
CHART_PATH="${CHART_PATH:-}"
DRY_RUN="${DRY_RUN:-0}"

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '[install-chart] %s\n' "$*" >&2; }

# Read a CloudFormation stack output by key.
cfn_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, '${key}')].OutputValue | [0]" \
    --output text
}

log "reading CDK outputs for stage $STAGE"
PG_HOST=$(cfn_output "${STAGE}-Data" PostgresEndpoint)
REDIS_HOST=$(cfn_output "${STAGE}-Data" ValkeyPrimaryEndpoint)
CERT_ARN=$(cfn_output "${STAGE}-Platform" CertArn)
HOSTNAME=$(cfn_output "${STAGE}-Platform" CertDomain)

[[ -z "$PG_HOST" || "$PG_HOST" == "None" ]] && err "PostgresEndpoint output missing — has Data stack deployed?"
[[ -z "$REDIS_HOST" || "$REDIS_HOST" == "None" ]] && err "ValkeyPrimaryEndpoint output missing"
[[ -z "$CERT_ARN" || "$CERT_ARN" == "None" ]] && err "CertArn output missing"
[[ -z "$HOSTNAME" || "$HOSTNAME" == "None" ]] && err "CertDomain output missing"

# Image refs come from CDK context — same source of truth as the
# imageRefs that get baked into Platform stack. Reading the context
# directly avoids the case where chart image tags drift away from
# what CDK provisioned for.
IMAGE_API=$(jq -r '."llmsafespaces:imageRefs".api' cdk.context.json)
IMAGE_CONTROLLER=$(jq -r '."llmsafespaces:imageRefs".controller' cdk.context.json)
IMAGE_FRONTEND=$(jq -r '."llmsafespaces:imageRefs".frontend' cdk.context.json)
IMAGE_BASE=$(jq -r '."llmsafespaces:imageRefs".base' cdk.context.json)

# Split image refs into repo + tag/digest for the chart's --set syntax.
split_image() {
  local ref="$1"
  if [[ "$ref" == *@sha256:* ]]; then
    echo "${ref%@*}|@${ref#*@}"
  else
    echo "${ref%:*}|${ref##*:}"
  fi
}

IFS='|' read -r API_REPO API_TAG <<< "$(split_image "$IMAGE_API")"
IFS='|' read -r CTL_REPO CTL_TAG <<< "$(split_image "$IMAGE_CONTROLLER")"
IFS='|' read -r FE_REPO FE_TAG <<< "$(split_image "$IMAGE_FRONTEND")"
IFS='|' read -r BASE_REPO BASE_TAG <<< "$(split_image "$IMAGE_BASE")"

# Clone the chart if no override was provided.
if [[ -z "$CHART_PATH" ]]; then
  CHART_PATH="${HOME}/.cache/llmsafespaces"
  if [[ ! -d "$CHART_PATH/.git" ]]; then
    log "cloning chart to $CHART_PATH"
    git clone --depth 1 https://github.com/lenaxia/LLMSafeSpaces.git "$CHART_PATH"
  else
    (cd "$CHART_PATH" && git fetch --depth 1 && git reset --hard origin/main)
  fi
  CHART_PATH="$CHART_PATH/charts/llmsafespaces"
fi

[[ -f "$CHART_PATH/Chart.yaml" ]] || err "chart not found at $CHART_PATH"

log "endpoints:"
log "  postgres = $PG_HOST"
log "  redis    = $REDIS_HOST"
log "  cert     = $CERT_ARN"
log "  hostname = $HOSTNAME"

CMD=(helm upgrade --install llmsafespaces "$CHART_PATH"
  -n llmsafespaces
  -f "$(dirname "$0")/../values.aws.yaml"
  --set "api.image.repository=$API_REPO"
  --set "api.image.tag=$API_TAG"
  --set "controller.image.repository=$CTL_REPO"
  --set "controller.image.tag=$CTL_TAG"
  --set "frontend.image.repository=$FE_REPO"
  --set "frontend.image.tag=$FE_TAG"
  --set "runtimeEnvironments.base.image.repository=$BASE_REPO"
  --set "runtimeEnvironments.base.image.tag=$BASE_TAG"
  --set "postgresql.host=$PG_HOST"
  --set "redis.host=$REDIS_HOST"
  --set "webhooks.failurePolicy=Ignore"
  --set "inferenceRelayURL="
  --set "frontend.ingress.host=$HOSTNAME"
  --set "api.config.security.allowedOrigins[0]=https://$HOSTNAME"
  --set "frontend.ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=$CERT_ARN"
  --wait --timeout 8m
)

if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "${CMD[@]}"
  exit 0
fi

log "running helm install"
"${CMD[@]}"

log "post-install: relax namespace PSA (workaround for lenaxia/LLMSafeSpaces#468)"
kubectl label namespace llmsafespaces \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=baseline \
  pod-security.kubernetes.io/warn=baseline \
  --overwrite

log "post-install: ConfigMap ClusterRole (workaround for lenaxia/LLMSafeSpaces#469)"
kubectl create clusterrole llmsafespaces-controller-cm \
  --verb=get,list,watch,create,update,patch --resource=configmaps \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create clusterrolebinding llmsafespaces-controller-cm \
  --clusterrole=llmsafespaces-controller-cm \
  --serviceaccount=llmsafespaces:llmsafespaces-controller \
  --dry-run=client -o yaml | kubectl apply -f -

log "rolling controller to pick up CM permissions"
kubectl -n llmsafespaces rollout restart deployment/llmsafespaces-controller
kubectl -n llmsafespaces rollout status deployment/llmsafespaces-controller --timeout=3m

log "done. final DNS step:"
ALB_HOSTNAME=$(kubectl -n llmsafespaces get ingress llmsafespaces-frontend \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "<wait a few seconds, then re-check>")
log "  CNAME $HOSTNAME -> $ALB_HOSTNAME"
