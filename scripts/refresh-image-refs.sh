#!/usr/bin/env bash
# refresh-image-refs.sh — update llmsafespaces:imageRefs in cdk.context.json
# to the latest published GHCR tag for each image.
#
# Records the digest of each ref as a sidecar `llmsafespaces:imageDigests`
# in the same context file. Use this to verify your deployed images
# weren't substituted before chart upgrade time — even if the upstream
# GHCR tag's underlying digest changes (rare but possible), CDK won't
# know, but you can `diff` against this recorded baseline.
#
# Ideal would be true digest pinning in the chart's image template
# (lenaxia/LLMSafeSpaces#476). Until that ships, this is the best we
# can do without a Helm post-renderer.
#
# Usage:
#   ./scripts/refresh-image-refs.sh             # show drift
#   ./scripts/refresh-image-refs.sh --apply     # write cdk.context.json
#   ./scripts/refresh-image-refs.sh --check     # exit nonzero if drift (CI)

set -euo pipefail

REPO_PATH="lenaxia/llmsafespaces"
IMAGES=(api controller frontend base)

APPLY=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --check) CHECK=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[refresh] %s\n' "$*" >&2; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v jq    >/dev/null || err "jq required"
command -v curl  >/dev/null || err "curl required"

# Fetch an anonymous GHCR pull token for one repo.
ghcr_token() {
  local repo="$1"
  curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull" \
    | jq -r .token
}

# Find the latest 'ts-*' tag for an image.
latest_tag() {
  local repo="$1" token
  token=$(ghcr_token "$repo")
  curl -fsSL -H "Authorization: Bearer $token" \
    "https://ghcr.io/v2/${repo}/tags/list?n=2000" \
    | jq -r '.tags | map(select(startswith("ts-"))) | sort | last'
}

# Get the OCI index digest for a tag.
index_digest() {
  local repo="$1" tag="$2" token
  token=$(ghcr_token "$repo")
  curl -fsSL -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -o /dev/null -D - \
    "https://ghcr.io/v2/${repo}/manifests/${tag}" \
    | grep -i 'docker-content-digest:' | awk '{print $2}' | tr -d '\r\n'
}

declare -A NEW_REFS
declare -A NEW_DIGESTS

for img in "${IMAGES[@]}"; do
  repo="${REPO_PATH}/${img}"
  log "querying $repo"
  tag=$(latest_tag "$repo")
  [[ -n "$tag" && "$tag" != "null" ]] || err "no ts-* tags for $repo"

  digest=$(index_digest "$repo" "$tag")
  [[ "$digest" == sha256:* ]] || err "no digest returned for $repo:$tag"

  ref="ghcr.io/${repo}:${tag}"
  log "  $img -> $ref ($digest)"
  NEW_REFS[$img]="$ref"
  NEW_DIGESTS[$img]="$digest"
done

# Read existing imageRefs.
CTX=cdk.context.json
[[ -f "$CTX" ]] || err "$CTX not found; run from project root"

OLD_REFS=$(jq -r '."llmsafespaces:imageRefs"' "$CTX")
NEW_REFS_JSON=$(jq -nc --arg api "${NEW_REFS[api]}" \
  --arg controller "${NEW_REFS[controller]}" \
  --arg frontend "${NEW_REFS[frontend]}" \
  --arg base "${NEW_REFS[base]}" \
  '{api:$api, controller:$controller, frontend:$frontend, base:$base}')
NEW_DIGESTS_JSON=$(jq -nc --arg api "${NEW_DIGESTS[api]}" \
  --arg controller "${NEW_DIGESTS[controller]}" \
  --arg frontend "${NEW_DIGESTS[frontend]}" \
  --arg base "${NEW_DIGESTS[base]}" \
  '{api:$api, controller:$controller, frontend:$frontend, base:$base}')

if [[ "$(echo "$OLD_REFS" | jq -S .)" == "$(echo "$NEW_REFS_JSON" | jq -S .)" ]]; then
  log "no drift; image refs are current"
  exit 0
fi

if [[ "$CHECK" == 1 ]]; then
  log "DRIFT detected (use --apply to write):"
  diff <(echo "$OLD_REFS" | jq -S .) <(echo "$NEW_REFS_JSON" | jq -S .) || true
  exit 1
fi

if [[ "$APPLY" == 1 ]]; then
  log "writing $CTX"
  jq --argjson refs "$NEW_REFS_JSON" --argjson digests "$NEW_DIGESTS_JSON" \
    '."llmsafespaces:imageRefs" = $refs | ."llmsafespaces:imageDigests" = $digests' \
    "$CTX" > "$CTX.tmp"
  mv "$CTX.tmp" "$CTX"
  log "done. Run 'cdk diff' to preview the change."
else
  log "drift detected; preview below. Re-run with --apply to write."
  diff <(echo "$OLD_REFS" | jq -S .) <(echo "$NEW_REFS_JSON" | jq -S .) || true
fi
