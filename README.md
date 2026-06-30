# llmsafespaces-aws-cdk

[AWS CDK](https://aws.amazon.com/cdk/) TypeScript project that provisions
the infrastructure to run
[lenaxia/LLMSafeSpaces](https://github.com/lenaxia/LLMSafeSpaces) on
Amazon EKS, plus the Helm overrides needed to drive the chart in that
environment.

This is the actual setup running at
[`safespaces.thekao.cloud`](https://safespaces.thekao.cloud).

Tested end-to-end on 2026-06-30 against a fresh AWS account in
`us-west-2`. Total time from `cdk bootstrap` to a serving `/readyz`
endpoint: ~70 minutes, the bulk of which is EKS control plane creation
(~10 min) and Valkey replication group creation (~10 min).

## What it builds

| Stack | Resources |
|---|---|
| `LlmSafeSpaces-Network` | VPC (10.42.0.0/16), 2 AZs, **1 NAT GW** (single-AZ, $33/mo savings), public + private + isolated subnet tiers with ELB tags for ALB discovery |
| `LlmSafeSpaces-Cluster` | EKS 1.32, **2× AMD64 spot nodes** (`m6a/m5a/t3a.large` mix for spot pool diversity), AL2023 with cgroup v2, EBS CSI driver, AWS Load Balancer Controller, cert-manager v1.16, **gVisor (runsc) installed via privileged DaemonSet**, RuntimeClass `gvisor` for workspace pod isolation, EKS API-mode auth with access entry for the AWS Admin role |
| `LlmSafeSpaces-Data` | RDS Postgres 17.10 (`db.t4g.micro` Graviton, single-AZ, 20 GiB gp3, SNAPSHOT removalPolicy), ElastiCache Valkey 8 (`cache.t4g.micro` Graviton, 1 node, **plaintext** — see "Known issues" below) |
| `LlmSafeSpaces-Platform` | ACM public cert for `safespaces.thekao.cloud` (DNS validation, manual CNAME), `llmsafespaces` namespace, `llmsafespaces-credentials` K8s Secret (postgres password + 4 generated app secrets) |

The Helm release of the chart itself is run **manually** after
`cdk deploy --all`. See "Install the chart" below.

## Cost (us-west-2 on-demand + spot)

| Item | Cost |
|---|---|
| EKS control plane | $73.00/mo |
| 2× `m6a.large` spot EC2 (730h) | ~$50/mo (vs ~$140 on-demand) |
| EBS for nodes (2× 50 GiB gp3) | ~$8/mo |
| EBS for workspace PVCs (assume 5× 1 GiB) | ~$0.40/mo |
| NAT Gateway (1× single AZ) | ~$33/mo + ~$0.045/GB |
| ALB | ~$16/mo + LCU |
| RDS db.t4g.micro single-AZ, 20 GiB gp3 | ~$13.50/mo |
| ElastiCache cache.t4g.micro single node | ~$11.70/mo |
| **Estimated total** | **~$205–230/mo** |

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
           │  │  Frontend    │  │
           │  └──────────────┘  │
           │  ┌──────────────┐  │
           │  │  API         │──┼─→ RDS Postgres (TLS, in isolated subnet)
           │  ├──────────────┤  │
           │  │  Controller  │──┼─→ ElastiCache Valkey (plaintext, isolated)
           │  └──────────────┘  │
           │                    │
           │  ┌──────────────┐  │
           │  │  Workspaces  │  │  (runtimeClassName: gvisor)
           │  │  (sandboxed) │  │
           │  └──────────────┘  │
           │                    │
           │  Nodes: 2× spot    │
           │  AL2023 + runsc    │
           │  (DaemonSet        │
           │   installs runsc)  │
           └────────────────────┘
```

## Prerequisites

- AWS account (uses default account/region: `572169125554` / `us-west-2` —
  edit `bin/app.ts` to change)
- Node.js 22+
- AWS CLI v2 configured with a profile that has enough permissions (we
  use one called `mikekao-prod` — pass `AWS_PROFILE=...` to all
  commands or edit the docs)
- `kubectl` 1.32+
- `helm` 3.13+ (Helm 4 also works)
- A DNS zone you control where you can add CNAME records for
  `<your hostname>` (we use `safespaces.thekao.cloud`)
- ~$10 of AWS credit for the time you spend testing (the cluster runs
  ~$0.30/hour)

## Deploy

```bash
export AWS_PROFILE=mikekao-prod
export AWS_REGION=us-west-2

# 1. Install CDK deps
cd llmsafespaces-aws-cdk
npm install

# 2. One-time CDK bootstrap (creates the staging bucket / IAM roles
#    CDK needs to deploy. Skip if already done in this account+region.)
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-west-2

# 3. Deploy the network + cluster + data + platform stacks.
#    Note: edit bin/app.ts first to set:
#      - your AWS account ID
#      - your region
#      - your hostname (e.g. `safespaces.example.com`)
#      - your admin IAM role ARN (the one your kubectl can assume)
#
#    Total time: ~30 minutes the first time. EKS control plane is the
#    slowest step (~10 min); RDS and Valkey are next (~10 min each,
#    in parallel).
npx cdk diff
npx cdk deploy --all --require-approval=never
```

**While the deploy is running**: the Platform stack creates an ACM cert
that does DNS validation. CFN will block on validation. Open the AWS
console → Certificate Manager → us-west-2 → the pending cert for your
hostname. Copy the CNAME name and CNAME value, and add it at your DNS
provider. CFN polls every 60s and unblocks once validation succeeds
(usually ~5 min after DNS propagation).

If you miss the window, CFN times out after ~25 min. You can re-run
`cdk deploy LlmSafeSpaces-Platform`.

## Wire kubectl

```bash
aws eks update-kubeconfig --name llmsafespaces \
  --region us-west-2 --profile mikekao-prod

kubectl get nodes   # should see 2 AL2023 nodes Ready
kubectl get pods -A # cert-manager, ALB controller, EBS CSI, gVisor installer all Running
```

Verify gVisor works:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gvisor-test
spec:
  runtimeClassName: gvisor
  restartPolicy: Never
  containers:
  - name: test
    image: public.ecr.aws/docker/library/alpine:3.20
    command: ["sh", "-c", "uname -a"]
EOF

kubectl logs gvisor-test
# Should print: Linux gvisor-test 4.19.0-gvisor ...
kubectl delete pod gvisor-test
```

## Install the chart

The chart isn't on a Helm repo yet, so clone the upstream repo:

```bash
git clone https://github.com/lenaxia/LLMSafeSpaces.git ~/llmsafespaces
```

Get the stack outputs:

```bash
PG_HOST=$(aws cloudformation describe-stacks \
  --stack-name LlmSafeSpaces-Data --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`PostgresEndpoint`].OutputValue' --output text)
REDIS_HOST=$(aws cloudformation describe-stacks \
  --stack-name LlmSafeSpaces-Data --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`ValkeyPrimaryEndpoint`].OutputValue' --output text)
CERT_ARN=$(aws cloudformation describe-stacks \
  --stack-name LlmSafeSpaces-Platform --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`CertArn`].OutputValue' --output text)
```

The chart's pre-install Secret resource is created with CDK tokens
that don't resolve at apply time, so we need to patch the K8s Secret
with the real RDS password from Secrets Manager before running helm:

```bash
PG_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name LlmSafeSpaces-Data --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`PostgresSecretArn`].OutputValue' --output text)

PG_PWD=$(aws secretsmanager get-secret-value --secret-id "$PG_SECRET_ARN" --region us-west-2 \
  --query 'SecretString' --output text \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['password'])")

kubectl -n llmsafespaces patch secret llmsafespaces-credentials \
  --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/data/postgres-password\",\"value\":\"$(printf '%s' "$PG_PWD" | base64 -w0)\"}]"
```

Then install:

```bash
helm install llmsafespaces ~/llmsafespaces/charts/llmsafespaces \
  -n llmsafespaces \
  -f values.aws.yaml \
  --set api.image.tag=ts-1782762331 \
  --set controller.image.tag=ts-1782762331 \
  --set frontend.image.tag=ts-1782762331 \
  --set runtimeEnvironments.base.image.tag=ts-1782762331 \
  --set postgresql.host=$PG_HOST \
  --set redis.host=$REDIS_HOST \
  --set webhooks.failurePolicy=Ignore \
  --set "api.ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=$CERT_ARN" \
  --wait --timeout 8m
```

`webhooks.failurePolicy=Ignore` is a workaround for a chicken-and-egg
issue: on first install the chart applies a `RuntimeEnvironment` CR
through a validating webhook served by the controller, but the
controller pod isn't ready yet. Once everything is up you can
`helm upgrade --set webhooks.failurePolicy=Fail` to flip it back.

Also relax the namespace's PSA from `restricted` to `baseline`
because of [lenaxia/LLMSafeSpaces#468](https://github.com/lenaxia/LLMSafeSpaces/issues/468):

```bash
kubectl label namespace llmsafespaces \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=baseline \
  pod-security.kubernetes.io/warn=baseline \
  --overwrite
```

And work around the ConfigMap RBAC scope issue
([lenaxia/LLMSafeSpaces#469](https://github.com/lenaxia/LLMSafeSpaces/issues/469)):

```bash
kubectl create clusterrole llmsafespaces-controller-cm \
  --verb=get,list,watch,create,update,patch --resource=configmaps

kubectl create clusterrolebinding llmsafespaces-controller-cm \
  --clusterrole=llmsafespaces-controller-cm \
  --serviceaccount=llmsafespaces:llmsafespaces-controller

kubectl -n llmsafespaces rollout restart deploy/llmsafespaces-controller
```

Verify:

```bash
kubectl -n llmsafespaces get pods
# All three (api, controller, frontend) should be Running 1/1

kubectl -n llmsafespaces logs deploy/llmsafespaces-controller | grep "free-models"
# free-models catalog refreshed {"count": ~21}
```

## Final DNS step

Get the ALB hostname:

```bash
kubectl -n llmsafespaces get ingress llmsafespaces-api \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Add a CNAME at your DNS provider:

```
<your hostname>  CNAME  <ALB hostname>.us-west-2.elb.amazonaws.com
TTL: 300
```

Then:

```bash
curl https://<your hostname>/livez   # → {"status":"ok"}
curl https://<your hostname>/readyz  # → {"status":"ready"}
```

## Known issues / upstream bugs

This deploy hit five bugs in `lenaxia/LLMSafeSpaces` that you'll need
the workarounds in this README for until they're fixed upstream:

- **[#454](https://github.com/lenaxia/LLMSafeSpaces/issues/454)** —
  `values-cluster.yaml` pins a GHCR tag that's been garbage-collected.
  Workaround: pin to a newer tag (`ts-1782762331` as of 2026-06-30) via
  `--set`.
- **[#462](https://github.com/lenaxia/LLMSafeSpaces/issues/462)** —
  Multi-arch images advertise `arm64` but contain x86-64 binaries
  inside the arm64 manifest variant. Pods on Graviton nodes
  `CrashLoopBackOff` with `exec format error`. **Workaround used here:
  run AMD64 nodes (m6a/m5a/t3a)**. This costs a few percent more than
  Graviton would but works.
- **[#465](https://github.com/lenaxia/LLMSafeSpaces/issues/465)** —
  API's Redis config has no TLS support; can't connect to ElastiCache
  with `TransitEncryptionEnabled`. Workaround: deploy Valkey with TLS
  off. Note this means workspace passwords cached in Valkey are in
  plaintext on the wire and at rest in cache memory. The cache SG is
  locked down to cluster traffic only, so practical exposure is limited
  to "EKS pods can read passwords from the cache", which is the same
  trust boundary as the API itself. Flip TLS back on once #465 is
  fixed.
- **[#468](https://github.com/lenaxia/LLMSafeSpaces/issues/468)** —
  frontend's `copy-html` initContainer is missing
  `capabilities.drop=[ALL]` and `seccompProfile=RuntimeDefault`.
  Workaround: relax namespace PSA to `baseline`.
- **[#469](https://github.com/lenaxia/LLMSafeSpaces/issues/469)** —
  Controller does a cluster-scoped ConfigMap watch but the chart's
  ClusterRole doesn't grant cluster-scoped ConfigMap access. Workaround:
  manual ClusterRole + ClusterRoleBinding.

## Design choices

| Choice | Why |
|---|---|
| **CDK TypeScript** vs Terraform / eksctl / CloudFormation | TypeScript has the best EKS construct support; `aws-cdk-lib`'s `eks.Cluster` + `AlbController` handle most footguns. |
| **2 AZs with 1 NAT GW** | EKS requires ≥2 AZs even for single-AZ workloads. One NAT GW saves $33/mo at the cost of an availability hit if that AZ goes down. Acceptable for MVP; flip to 2 NAT GWs for prod. |
| **EKS auth mode: API (access entries)** | Modern, IAM-driven access control. Avoids the legacy `aws-auth` ConfigMap. |
| **Spot capacity with 3 instance types** | Spot is ~70% cheaper than on-demand. Single instance type (`m7g.large` originally) hit `UnfulfillableCapacity` in our AZ; diversifying across 3 families fixed it. |
| **AL2023 (not Bottlerocket)** | We need privileged DaemonSet access to `/etc/containerd/config.toml` to install runsc. Bottlerocket's containerd config is partially immutable; AL2023's is editable. Both have cgroup v2 by default. |
| **gVisor via DaemonSet, not userData** | AL2023's nodeadm expects MIME-multipart userData, which is fragile to author. A privileged DaemonSet on every node post-bootstrap drops runsc binaries and edits containerd config in place, then `nsenter` restarts containerd. Robust and survives node replacement. |
| **gVisor release 20260622** | Latest available with ARM64 + AMD64 binaries on GCS. Pinned because the `latest` symlink can break reproducibility. |
| **ALB (L7) not NLB (L4)** | ACM cert termination is easier on ALB; the chart's Ingress object provisions one with three annotations. |
| **RDS Postgres single-AZ** | Cheapest viable. RDS auto-creates the `llmsafespaces` database on first boot. The chart's pre-install migrations Job populates the schema. |
| **ElastiCache Valkey 8** | Bug #465 means TLS is off, which is the only configurable. Plaintext is uncomfortable but the cache SG is locked down. |
| **`webhooks.failurePolicy: Ignore` on first install** | Chart's pre-install validation webhook requires the controller pod to already exist. Once the platform is up, you can flip back to `Fail`. |

## Teardown

```bash
# Uninstall the chart (drops PVCs, secrets except llmsafespaces-credentials
# which has helm.sh/resource-policy: keep)
helm uninstall llmsafespaces -n llmsafespaces

# Clean up CRDs (Helm 3 doesn't delete them by default)
kubectl delete crd \
  workspaces.llmsafespaces.dev \
  runtimeenvironments.llmsafespaces.dev \
  inferencerelays.llmsafespaces.dev

# Clean up the workaround ClusterRoleBinding
kubectl delete clusterrolebinding llmsafespaces-controller-cm
kubectl delete clusterrole llmsafespaces-controller-cm

# Destroy CDK stacks (in reverse dependency order, CDK handles this)
npx cdk destroy --all
```

RDS uses `removalPolicy: SNAPSHOT` so you get a final snapshot.
ElastiCache has no snapshot retention on teardown — data is lost.
The ACM cert is retained by default (cheap to keep).

## What's still TODO

- **Multi-AZ posture** for production: flip `natGateways: 2`,
  `multiAz: true` on RDS, `numCacheClusters: 2` on Valkey.
- **External-secrets operator** to read from Secrets Manager at deploy
  time instead of the manual `kubectl patch` step.
- **Kyverno or OPA** to enforce PodSecurity `restricted` cluster-wide
  (waiting on #468 upstream).
- **Karpenter** instead of managed node groups for finer spot pool
  diversity and faster scale-up.
- **GitHub Actions** for `cdk deploy` on push to main.
- **Workspace IAM roles** via IRSA so workspace pods can access
  customer-specific AWS resources without long-lived credentials.

## License

MIT. Same as upstream llmsafespaces.

## Acknowledgments

Built atop [lenaxia/LLMSafeSpaces](https://github.com/lenaxia/LLMSafeSpaces).
Deploy gotchas surfaced and filed as upstream issues #454, #462, #465,
#468, #469 — see [Known issues](#known-issues--upstream-bugs).
