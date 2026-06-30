#!/usr/bin/env bash
# teardown.sh — uninstall the chart, clean up workarounds, and destroy CDK stacks.
#
# Usage:
#   AWS_PROFILE=mikekao-prod ./scripts/teardown.sh

set -euo pipefail

: "${AWS_PROFILE:?set AWS_PROFILE first}"
: "${AWS_REGION:=us-west-2}"

STAGE="${STAGE:-LlmSafeSpaces}"

log() { printf '[teardown] %s\n' "$*" >&2; }

confirm() {
  read -rp "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]] || { log "aborted"; exit 1; }
}

confirm "This will delete all data (RDS final snapshot will be taken; Valkey data is lost). Continue?"

if helm status llmsafespaces -n llmsafespaces >/dev/null 2>&1; then
  log "uninstalling chart"
  helm uninstall llmsafespaces -n llmsafespaces || true
  kubectl -n llmsafespaces delete pvc --all --ignore-not-found || true
fi

log "cleaning chart CRDs"
kubectl delete crd \
  workspaces.llmsafespaces.dev \
  runtimeenvironments.llmsafespaces.dev \
  inferencerelays.llmsafespaces.dev \
  --ignore-not-found || true

log "cleaning workaround ClusterRoleBinding"
kubectl delete clusterrolebinding llmsafespaces-controller-cm --ignore-not-found
kubectl delete clusterrole llmsafespaces-controller-cm --ignore-not-found

log "destroying CDK stacks (~15 minutes)"
npx cdk destroy --all --force

log "done. Note: the ACM cert is retained by default."
