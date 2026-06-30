# llmsafespaces-aws-cdk

AWS CDK project that provisions infrastructure for
[lenaxia/LLMSafeSpaces](https://github.com/lenaxia/LLMSafeSpaces) on EKS.

This is the live setup for [safespaces.thekao.cloud](https://safespaces.thekao.cloud).

## What this builds

| Stack | Resources |
|---|---|
| `Network` | VPC, 2 AZs, tier-driven NAT redundancy (1 NAT for mvp, 2 for prod), public/private/isolated subnets with ALB discovery tags |
| `Cluster` | EKS 1.32, AL2023 AMD64 nodes (spot for mvp, on-demand for prod), EBS CSI driver, AWS Load Balancer Controller, cert-manager, external-secrets-operator, gVisor installer DaemonSet, RuntimeClass `gvisor` |
| `Data` | RDS Postgres 17.10 (single-AZ for mvp, Multi-AZ for prod), ElastiCache Valkey 8 (single node for mvp, replicated for prod) |
| `Platform` | ACM cert, `llmsafespaces` namespace, four app-level secrets in AWS Secrets Manager (jwt, master, internal-token, inference-relay-secret), ClusterSecretStore + ExternalSecret that materializes the `llmsafespaces-credentials` K8s Secret at apply time |

Helm install of the chart itself is run by `scripts/install-chart.sh`
after `cdk deploy` completes.

## Cost

| Tier | Monthly cost (us-west-2) |
|---|---|
| `mvp`  | ~$205–230 (spot nodes, 1 NAT, single-AZ data) |
| `prod` | ~$700–900 (on-demand nodes, 2 NATs, Multi-AZ data, replicated Valkey) |

## Architecture

```
                    Internet
                       │
                       ▼
       Public ALB (alb.ingress.kubernetes.io)
                       │ HTTPS (ACM cert)
                       ▼
           ┌───────────────────┐
           │  EKS cluster       │
           │                    │
           │  ┌──────────────┐  │
           │  │  Frontend    │  │ ──> /
           │  └──────────────┘  │
           │  ┌──────────────┐  │
           │  │  API         │  │ ──> /api
           │  ├──────────────┤  │
           │  │  Controller  │  │
           │  └──────────────┘  │
           │  ┌──────────────┐  │
           │  │  external-   │  │ ──> Secrets Manager
           │  │  secrets-op  │  │     (jwt, postgres-pwd, etc.)
           │  └──────────────┘  │
           │                    │
           │  ┌──────────────┐  │
           │  │  Workspaces  │  │ (runtimeClassName: gvisor)
           │  │  (sandboxed) │  │
           │  └──────────────┘  │
           │                    │
           │  Nodes: AL2023     │
           │  + runsc (gVisor   │
           │    installer       │
           │    DaemonSet)      │
           └────────────────────┘
                  │           │
                  ▼           ▼
                RDS         ElastiCache
              Postgres        Valkey
              (isolated     (isolated
              subnet)        subnet)
```

## Prerequisites

- AWS account, AWS CLI v2 configured
- Node.js 22+
- `kubectl` 1.32+, `helm` 3.13+, `jq`, `curl`
- A DNS zone you control where you can add a CNAME

## Quick start

```bash
git clone https://github.com/lenaxia/llmsafespaces-aws-cdk.git
cd llmsafespaces-aws-cdk

# 1. Copy and edit the context file
cp cdk.context.example.json cdk.context.json
# Edit cdk.context.json with your account, hostname, admin role ARN, etc.

# 2. Install dependencies
npm install

# 3. Bootstrap CDK in your account (one-time)
export AWS_PROFILE=your-profile
npx cdk bootstrap

# 4. Synth + diff to preview
npm test                     # 21 tests
npx cdk synth --quiet
npx cdk diff

# 5. Deploy (~30 minutes; control plane is slowest)
npx cdk deploy --all

# DURING THE DEPLOY: the Platform stack waits on ACM DNS validation.
# Open ACM console, find the pending cert, copy the validation CNAME,
# add it to your DNS provider. CFN polls and unblocks within ~5 min
# after propagation.

# 6. Wire kubectl
aws eks update-kubeconfig --name llmsafespaces --region us-west-2

# 7. Install the chart
./scripts/install-chart.sh

# 8. Add the final DNS record
# scripts/install-chart.sh prints the ALB hostname.
# Add a CNAME: <your hostname> -> <ALB hostname>.us-west-2.elb.amazonaws.com
```

## Configuration

All configuration lives in `cdk.context.json` (gitignored).
`cdk.context.example.json` is the committed template.

| Key | Required | Default | Notes |
|---|---|---|---|
| `llmsafespaces:account` | yes | — | 12-digit AWS account ID |
| `llmsafespaces:region` | no | `us-west-2` | |
| `llmsafespaces:hostname` | yes | — | Public hostname for the ALB |
| `llmsafespaces:adminRoleArn` | yes | — | IAM role granted cluster-admin |
| `llmsafespaces:awsProfile` | no | `default` | Cosmetic, for output strings |
| `llmsafespaces:tier` | no | `mvp` | `mvp` or `prod` |
| `llmsafespaces:imageRefs` | no | tagged | Per-image refs; refreshed by `scripts/refresh-image-refs.sh` |
| `llmsafespaces:nodeInstanceTypes` | no | `[m6a, m5a, t3a].large` | Spot pool diversity |
| `llmsafespaces:nodeSpot` | no | tier-derived | Spot vs on-demand |
| `llmsafespaces:valkeyTls` | no | `false` | Off until lenaxia/LLMSafeSpaces#465 |

The `tier` key flips a set of HA-posture knobs together (NAT count,
RDS Multi-AZ, Valkey replicas, deletion protection, etc.). See
`lib/config.ts` → `haPostureFor()` for the full mapping.

## Multi-environment deploy

For a Dev + Prod setup, override the stage name via context:

```bash
# Deploy a dev environment in a separate account / smaller hosts
npx cdk deploy --all \
  --context stage=Dev \
  --context llmsafespaces:account=111111111111 \
  --context llmsafespaces:hostname=dev.example.com \
  --context llmsafespaces:adminRoleArn=arn:aws:iam::111111111111:role/Admin \
  --context llmsafespaces:tier=mvp

# Deploy prod separately
npx cdk deploy --all \
  --context stage=Prod \
  --context llmsafespaces:account=222222222222 \
  --context llmsafespaces:hostname=safespaces.example.com \
  --context llmsafespaces:adminRoleArn=arn:aws:iam::222222222222:role/Admin \
  --context llmsafespaces:tier=prod
```

Stack names are namespaced by stage: `Dev-Network`, `Dev-Cluster`,
`Prod-Network`, `Prod-Cluster`, etc.

## Operations

### Refresh image refs

```bash
./scripts/refresh-image-refs.sh             # show drift
./scripts/refresh-image-refs.sh --apply     # update cdk.context.json
./scripts/refresh-image-refs.sh --check     # exit 1 if drift (for CI)
```

### Tests

```bash
npm test          # 21 tests covering Network/Cluster/Data/Platform + config validation
```

### Teardown

```bash
./scripts/teardown.sh
```

Uninstalls the chart, deletes the CDK stacks (~15 min). RDS uses
`removalPolicy: SNAPSHOT` so a final snapshot is taken; Valkey data is lost.

## Design choices

| Choice | Why |
|---|---|
| **CDK TypeScript** | Best EKS construct support; `eks.Cluster` + `AlbController` handle most footguns |
| **`cdk.Stage` + per-environment instantiation** | Lets one repo deploy dev + prod with no code duplication |
| **Context-driven config** (`lib/config.ts`) | Single source of truth, validated at synth time |
| **EKS API auth mode + access entries** | Modern IAM-driven access control |
| **AL2023 AMD64 nodes** | gVisor install needs to write to containerd config (Bottlerocket is read-only there); AMD64 because lenaxia/LLMSafeSpaces#462 |
| **Tier-driven HA posture** | `mvp` → single-AZ/spot; `prod` → Multi-AZ/on-demand. One toggle flips ~7 knobs |
| **Spot capacity with 3 instance families** | Avoids `UnfulfillableCapacity` in any single pool |
| **Secrets Manager + external-secrets-operator** | Replaces the previous synth-time secret generation hack. Secrets stable across synths, materialized as K8s Secrets at apply time, rotatable in-place |
| **gVisor via DaemonSet** | Privileged DaemonSet installs runsc post-bootstrap. Validates arch + version on each iteration; sets `GvisorReady` NodeCondition |
| **Helm install via script, not CDK Helm chart** | Chart isn't on a Helm repo; wiring it into CDK adds churn for limited benefit |

## Known issues (upstream)

Workarounds for these are applied automatically by `scripts/install-chart.sh`.

- [lenaxia/LLMSafeSpaces#454](https://github.com/lenaxia/LLMSafeSpaces/issues/454) — GHCR garbage-collects old tags. Workaround: `scripts/refresh-image-refs.sh` tracks the latest tag + records digests.
- [#462](https://github.com/lenaxia/LLMSafeSpaces/issues/462) — arm64 images contain x86-64 binaries. Workaround: AMD64 nodes (default in this repo).
- [#465](https://github.com/lenaxia/LLMSafeSpaces/issues/465) — Chart's Redis client has no TLS support. Workaround: `valkeyTls: false`. Flip when upstream ships TLS support.
- [#468](https://github.com/lenaxia/LLMSafeSpaces/issues/468) — Frontend `copy-html` initContainer fails PSA `restricted`. Workaround: namespace labeled `baseline`.
- [#469](https://github.com/lenaxia/LLMSafeSpaces/issues/469) — Controller cluster-scoped ConfigMap watch missing RBAC. Workaround: manual ClusterRole + binding.
- [#473](https://github.com/lenaxia/LLMSafeSpaces/issues/473) — Frontend ingress doesn't strip `/api` prefix. **No clean workaround**; UI calls 404 until upstream fixes this.
- [#474](https://github.com/lenaxia/LLMSafeSpaces/issues/474) — Default `inferenceRelayURL` points at private maintainer relay. Workaround: `inferenceRelayURL: ""` in values, routes directly to `opencode.ai/zen/v1`.
- [#476](https://github.com/lenaxia/LLMSafeSpaces/issues/476) — Chart's image template doesn't support digest pinning. Workaround: track tag + digest separately in `cdk.context.json`.

## License

MIT.
