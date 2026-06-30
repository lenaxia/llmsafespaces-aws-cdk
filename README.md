# llmsafespaces-aws-cdk

AWS CDK project that provisions the foundational infrastructure for
[lenaxia/LLMSafeSpaces](https://github.com/lenaxia/LLMSafeSpaces) on EKS,
plus a FluxCD bootstrap pointing at the companion ops repo
[lenaxia/llmsafespaces-ops-prod](https://github.com/lenaxia/llmsafespaces-ops-prod).

This is the live setup for [safespaces.thekao.cloud](https://safespaces.thekao.cloud).

## Three-repo architecture

| Repo | Concern |
|---|---|
| [lenaxia/LLMSafeSpaces](https://github.com/lenaxia/LLMSafeSpaces) | The app itself: code, Helm chart, container images |
| **this repo** | AWS-side foundational infrastructure: VPC, EKS, RDS, Valkey, ACM, IAM roles, Flux installation |
| [lenaxia/llmsafespaces-ops-prod](https://github.com/lenaxia/llmsafespaces-ops-prod) | K8s state continuously reconciled by Flux: HelmReleases, ExternalSecrets, NetworkPolicies, monitoring stack |

The split: **CDK owns cloud-API resources** (one-shot, infrequent changes),
**ops-prod owns cluster state** (continuously reconciled).

## What this builds

| Stack | Resources |
|---|---|
| `Network` | VPC, 2 AZs, tier-driven NAT redundancy, public/private/isolated subnets with ALB discovery tags |
| `Cluster` | EKS 1.32, AL2023 AMD64 nodes (spot for mvp, on-demand for prod), EBS CSI driver, AWS Load Balancer Controller, gVisor installer DaemonSet, **FluxCD installed and pointed at ops-prod** |
| `Data` | RDS Postgres 17.10, ElastiCache Valkey 8 |
| `Platform` | ACM cert, llmsafespaces + flux-system namespaces, four app-level Secrets Manager secrets, **cluster-config ConfigMap exposing all ARNs/endpoints to Flux** |

Everything beyond that — the chart install, ExternalSecrets, cert-manager,
external-secrets-operator, future monitoring/security apps — lives in
ops-prod and is applied by Flux.

## Cost (us-west-2 spot)

| Tier | Monthly cost |
|---|---|
| `mvp`  | ~$205–230 (spot nodes, 1 NAT, single-AZ data) |
| `prod` | ~$700–900 (on-demand nodes, 2 NATs, Multi-AZ data, replicated Valkey) |

## Prerequisites

- AWS account, AWS CLI v2 configured
- Node.js 22+
- `kubectl` 1.32+, `helm` 3.13+, `jq`, `curl`
- `flux` CLI 2.7+ (for verification only; install is automated)
- `age` private key matching the SOPS recipient in
  [llmsafespaces-ops-prod/.sops.yaml](https://github.com/lenaxia/llmsafespaces-ops-prod/blob/main/.sops.yaml)
- A DNS zone you control where you can add CNAMEs

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
npm test                     # 22 tests
npx cdk synth --quiet
npx cdk diff

# 5. Deploy (~30 minutes; control plane is slowest)
npx cdk deploy 'LlmSafeSpaces/*'

# DURING DEPLOY: the Platform stack waits on ACM DNS validation.
# Open ACM console, find the pending cert, copy the validation CNAME,
# add it to your DNS provider. CFN polls and unblocks within ~5 min
# after propagation.

# 6. Wire kubectl
aws eks update-kubeconfig --name llmsafespaces --region us-west-2

# 7. Create the SOPS age key Secret so Flux can decrypt secrets in ops-prod
kubectl create secret generic sops-age -n flux-system \
  --from-file=age.agekey=$HOME/.config/sops/age/keys.txt

# 8. Watch Flux take over
flux get all -A
# Within ~5 min you should see ExternalSecret, cert-manager, llmsafespaces
# all reconciled.

# 9. Get the ALB hostname and update DNS
kubectl -n llmsafespaces get ingress llmsafespaces-frontend \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
# CNAME <your hostname> -> <ALB hostname>
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
| `llmsafespaces:opsRepoUrl` | no | `https://github.com/lenaxia/llmsafespaces-ops-prod.git` | Flux GitRepository source |
| `llmsafespaces:opsRepoBranch` | no | `main` | |

## Multi-environment deploy

```bash
# Dev environment in a separate account
npx cdk deploy 'Dev/*' \
  --context stage=Dev \
  --context llmsafespaces:account=111111111111 \
  --context llmsafespaces:hostname=dev.example.com \
  --context llmsafespaces:adminRoleArn=arn:aws:iam::111111111111:role/Admin \
  --context llmsafespaces:tier=mvp
```

Stack names are namespaced by stage: `Dev-Network`, `Dev-Cluster`, etc.

## Operations

### Refresh image refs
```bash
./scripts/refresh-image-refs.sh             # show drift
./scripts/refresh-image-refs.sh --apply     # update cdk.context.json
./scripts/refresh-image-refs.sh --check     # exit 1 if drift (for CI)
```

After updating, `git commit && git push` to cdk.context.json. Then
`cdk deploy 'LlmSafeSpaces/Platform'` to push the new ARNs/refs into
the cluster-config ConfigMap. Flux picks up the new image refs at the
next reconcile (~2 min).

### Tests
```bash
npm test          # 22 tests covering Network/Cluster/Data/Platform + config validation
```

### Teardown
```bash
./scripts/teardown.sh
```

Uninstalls everything in reverse order: Helm releases via Flux,
finalizer cleanup, CDK destroy. ~15 min. RDS uses `removalPolicy: SNAPSHOT`
so a final snapshot is taken; Valkey data is lost.

## Design choices

| Choice | Why |
|---|---|
| **CDK + Flux split** | CDK is great at cloud APIs, bad at continuous reconciliation. Flux is the opposite. Each does one thing well. |
| **`cdk.Stage` + per-environment instantiation** | Lets one repo deploy dev + prod with no code duplication |
| **Context-driven config** (`lib/config.ts`) | Single source of truth, validated at synth time |
| **EKS API auth mode + access entries** | Modern IAM-driven access control |
| **AL2023 AMD64 nodes** | gVisor needs writable containerd config; AMD64 because lenaxia/LLMSafeSpaces#462 |
| **Tier-driven HA posture** | `mvp` → single-AZ/spot; `prod` → Multi-AZ/on-demand. One toggle flips ~7 knobs |
| **Spot capacity with 3 instance families** | Avoids `UnfulfillableCapacity` in any single pool |
| **Secrets Manager + ESO** | Replaces previous synth-time secret hacks. Values stable across synths, materialized at apply time, rotatable |
| **gVisor via DaemonSet** | Privileged DaemonSet installs runsc post-bootstrap. Validates arch + version; sets `GvisorReady` NodeCondition |
| **Flux installed by CDK, then self-managing** | One-button deploy: `cdk deploy --all` results in a Flux-managed cluster pointing at ops-prod |
| **Manual sops-age secret bootstrap** | One unavoidable manual step. Operator brings their age private key; CDK creates the Secret would require pre-storing it in SM, chicken-and-egg |

## Known issues (upstream)

Workarounds for these live in ops-prod, not here.

- [lenaxia/LLMSafeSpaces#454](https://github.com/lenaxia/LLMSafeSpaces/issues/454) GHCR tag GC
- [#462](https://github.com/lenaxia/LLMSafeSpaces/issues/462) arm64 image has x86-64 binary
- [#465](https://github.com/lenaxia/LLMSafeSpaces/issues/465) No Redis TLS support
- [#468](https://github.com/lenaxia/LLMSafeSpaces/issues/468) frontend copy-html PSA restricted
- [#469](https://github.com/lenaxia/LLMSafeSpaces/issues/469) controller CM watch RBAC
- [#473](https://github.com/lenaxia/LLMSafeSpaces/issues/473) frontend ingress /api prefix not stripped
- [#474](https://github.com/lenaxia/LLMSafeSpaces/issues/474) chart defaults relay URL to private CF Worker
- [#476](https://github.com/lenaxia/LLMSafeSpaces/issues/476) chart image template doesn't support digest pinning

Track production hardening in [issue #12](https://github.com/lenaxia/llmsafespaces-aws-cdk/issues/12).

## License
