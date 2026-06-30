import * as eks from 'aws-cdk-lib/aws-eks';

/**
 * Pinned gVisor release. Verify ARM64 + AMD64 binaries exist on GCS
 * before bumping: `curl -fsSI https://storage.googleapis.com/gvisor/
 * releases/release/<release>/x86_64/runsc` should return 200.
 *
 * Bumping requires re-installing on every node (delete /usr/local/bin/
 * runsc on each, restart the DaemonSet). The version-aware install
 * script handles this automatically.
 */
const GVISOR_RELEASE = '20260622';

/**
 * Architecture string for gVisor's GCS path. Workspaces run on AMD64
 * for now (lenaxia/LLMSafeSpaces#462); switch to 'aarch64' when the
 * upstream arm64 image bug is fixed and we move to Graviton nodes.
 */
const GVISOR_ARCH = 'x86_64';

/**
 * Install runsc + containerd-shim-runsc-v1 on every node via a
 * privileged DaemonSet, then register the `gvisor` RuntimeClass.
 *
 * Design:
 *
 *   1. RuntimeClass `gvisor` — referenced by the chart's workspace pods
 *      (default-runtime-class flag in controller).
 *      NOTE: the chart's templates/runtime-class.yaml ALSO creates this
 *      RuntimeClass. The chart's manifest wins on `helm install`;
 *      this one is here for CDK-only deploys (no chart). On clusters
 *      with both, the chart manifest takes precedence due to creation
 *      order (Helm applies after CDK). If you deploy CDK-only, the
 *      chart's manifest is absent and ours is the source of truth.
 *
 *   2. DaemonSet `gvisor-installer` in namespace `gvisor-system`.
 *      Each pod:
 *      - Checks if the installed runsc binary architecture matches
 *        `uname -m`. If not, removes the stale binary.
 *      - Checks if `runsc --version` matches the pinned release. If
 *        not, downloads and installs.
 *      - Splices the containerd runtime handler into
 *        /host/etc/containerd/config.toml (idempotent grep guard).
 *      - Restarts containerd via `nsenter` into PID 1's namespaces.
 *      - Sets NodeCondition `GvisorReady=True` on the host node via
 *        the K8s API.
 *      - Idles.
 *
 *   3. Chart's workspace pods set `nodeAffinity` requiring
 *      `node.status.conditions[GvisorReady]=True`. (To be added to
 *      values.aws.yaml as `workspace.nodeAffinity` once the chart
 *      supports it; for now, the DaemonSet writes the condition and
 *      operators can scope their workspace pods to gVisor-ready nodes.)
 *
 * Robustness over the previous version (issues #11, #6):
 *   - Arch check prevents stale aarch64 binaries from persisting after
 *     an ARM→AMD node group replacement
 *   - Version check enables automatic upgrades when GVISOR_RELEASE
 *     bumps
 *   - NodeCondition gives the scheduler a signal that gVisor is ready
 *     on this node (so workspace pods don't schedule onto a node where
 *     the installer hasn't finished yet)
 */
export function buildGvisorInstaller(cluster: eks.Cluster) {
  const script = buildInstallScript();

  return cluster.addManifest(
    'GvisorInstaller',
    // Namespace
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'gvisor-system' },
    },
    // ServiceAccount (assumes node role; needs Node patch via host kubelet)
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'gvisor-installer', namespace: 'gvisor-system' },
    },
    // ClusterRole — permission to patch Node status (NodeCondition)
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: 'gvisor-installer-node-patcher' },
      rules: [{
        apiGroups: [''],
        resources: ['nodes', 'nodes/status'],
        verbs: ['get', 'patch', 'update'],
      }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'gvisor-installer-node-patcher' },
      subjects: [{
        kind: 'ServiceAccount',
        name: 'gvisor-installer',
        namespace: 'gvisor-system',
      }],
      roleRef: {
        kind: 'ClusterRole',
        name: 'gvisor-installer-node-patcher',
        apiGroup: 'rbac.authorization.k8s.io',
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'gvisor-install-script', namespace: 'gvisor-system' },
      data: { 'install.sh': script },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'DaemonSet',
      metadata: { name: 'gvisor-installer', namespace: 'gvisor-system' },
      spec: {
        selector: { matchLabels: { app: 'gvisor-installer' } },
        // Force pod recreation when ConfigMap content changes — Helm
        // pattern. Without an annotation that varies with content,
        // `kubectl rollout restart` is required after a script update.
        // CDK doesn't templating, so we'd have to compute a hash; for
        // now operators run `kubectl rollout restart` after upgrades.
        template: {
          metadata: { labels: { app: 'gvisor-installer' } },
          spec: {
            serviceAccountName: 'gvisor-installer',
            hostPID: true,
            tolerations: [{ operator: 'Exists' }],
            containers: [{
              name: 'installer',
              image: 'public.ecr.aws/docker/library/alpine:3.20',
              securityContext: { privileged: true },
              command: ['/bin/sh', '/scripts/install.sh'],
              env: [{
                name: 'NODE_NAME',
                valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } },
              }],
              volumeMounts: [
                { name: 'host-root', mountPath: '/host' },
                { name: 'script', mountPath: '/scripts' },
                { name: 'kube-api-access', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true },
              ],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            }],
            volumes: [
              { name: 'host-root', hostPath: { path: '/' } },
              { name: 'script', configMap: { name: 'gvisor-install-script', defaultMode: 0o755 } },
              { name: 'kube-api-access', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } },
            ],
          },
        },
      },
    },
  );
}

function buildInstallScript(): string {
  return `#!/bin/sh
# gVisor installer — runs once per node, validates arch + version,
# installs runsc, registers containerd handler, sets NodeCondition.

set -eu

NODE_NAME="\${NODE_NAME:?NODE_NAME env var required}"
HOST_ARCH=$(uname -m)
EXPECTED_ARCH='${GVISOR_ARCH}'
RELEASE='${GVISOR_RELEASE}'
RUNSC=/host/usr/local/bin/runsc
SHIM=/host/usr/local/bin/containerd-shim-runsc-v1
CONFIG=/host/etc/containerd/config.toml
HANDLER_MARKER='containerd.runtimes.runsc'

log() { printf '[gvisor-installer] %s\\n' "$*"; }
fatal() { log "FATAL: $*"; exit 1; }

[ "$HOST_ARCH" = "$EXPECTED_ARCH" ] || fatal "host arch $HOST_ARCH != expected $EXPECTED_ARCH; node group misconfigured?"

apk add --no-cache curl util-linux file >/dev/null

# Verify existing install: file exists AND is correct architecture
# AND reports the expected version. Otherwise, reinstall.
needs_install=true
if [ -x "$RUNSC" ]; then
  installed_arch=$(file -b "$RUNSC" | awk -F, '{print $2}' | tr -d ' ')
  case "$HOST_ARCH" in
    x86_64)  expected_file_arch='x86-64' ;;
    aarch64) expected_file_arch='ARMaarch64' ;;
    *) fatal "unsupported host arch $HOST_ARCH" ;;
  esac

  if [ "$installed_arch" = "$expected_file_arch" ]; then
    installed_version=$(chroot /host /usr/local/bin/runsc --version 2>/dev/null | head -1 || echo "")
    expected_version="runsc version release-$RELEASE"
    if [ "$installed_version" = "$expected_version" ]; then
      log "correct binary present (arch=$installed_arch version=$installed_version); skipping download"
      needs_install=false
    else
      log "version mismatch: installed='$installed_version' expected='$expected_version'; reinstalling"
    fi
  else
    log "arch mismatch: installed binary is '$installed_arch' but host is '$HOST_ARCH'; reinstalling"
  fi
fi

if [ "$needs_install" = "true" ]; then
  log "downloading runsc release $RELEASE for $EXPECTED_ARCH"
  curl -fsSL -o /tmp/runsc \\
    "https://storage.googleapis.com/gvisor/releases/release/$RELEASE/$EXPECTED_ARCH/runsc"
  curl -fsSL -o /tmp/containerd-shim-runsc-v1 \\
    "https://storage.googleapis.com/gvisor/releases/release/$RELEASE/$EXPECTED_ARCH/containerd-shim-runsc-v1"
  install -m 755 /tmp/runsc "$RUNSC"
  install -m 755 /tmp/containerd-shim-runsc-v1 "$SHIM"
  log "installed runsc + shim"
fi

# Splice handler into containerd config (idempotent).
if ! grep -q "$HANDLER_MARKER" "$CONFIG"; then
  log "appending runsc handler to containerd config"
  cat >> "$CONFIG" <<EOF

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
EOF
  needs_restart=true
else
  needs_restart=false
fi

if [ "$needs_install" = "true" ] || [ "$needs_restart" = "true" ]; then
  log "restarting containerd"
  nsenter -t 1 -m -u -i -n -p systemctl restart containerd
  # Give containerd a moment to start before declaring the node ready.
  sleep 5
fi

# Mark NodeCondition GvisorReady=True via the K8s API. Apps that need
# gVisor should set nodeAffinity requiring this condition.
log "patching NodeCondition GvisorReady=True on $NODE_NAME"
K8S_HOST=\${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}
K8S_PORT=\${KUBERNETES_SERVICE_PORT:-443}
TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PATCH=$(printf '{"status":{"conditions":[{"type":"GvisorReady","status":"True","reason":"InstallerComplete","message":"runsc %s installed","lastHeartbeatTime":"%s","lastTransitionTime":"%s"}]}}' \\
  "$RELEASE" "$NOW" "$NOW")

# Use /status subresource for node condition updates.
HTTP_STATUS=$(curl -sk --cacert "$CACERT" \\
  -X PATCH \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/strategic-merge-patch+json" \\
  -o /tmp/patch-resp \\
  -w "%{http_code}" \\
  --data "$PATCH" \\
  "https://$K8S_HOST:$K8S_PORT/api/v1/nodes/$NODE_NAME/status")

if [ "$HTTP_STATUS" != "200" ]; then
  log "warning: NodeCondition patch returned HTTP $HTTP_STATUS"
  cat /tmp/patch-resp
fi

log "done; idling"
exec sleep infinity
`;
}
