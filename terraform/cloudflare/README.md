# Cloudflare configuration for llmsafespaces

> **STATUS (2026-07-02)**: This Terraform module is **NOT** the current source of truth for the prod Cloudflare zone. The 2026-07-02 cutover used direct Cloudflare v4 API calls (curl-based, documented in `../../../llmsafespaces-ops-prod/docs/runbooks/cloudflare-cutover.md` under "Path A"). This module exists for future use if the team ever grows past one operator, but it has known Free-tier incompatibilities that need fixing before `terraform apply` will succeed. See "Free-tier limitations" below.

Terraform module that manages the Cloudflare zone in front of the ALB:

- DNS records (`safespaces.thekao.cloud`, `grafana.safespaces.thekao.cloud`) → ALB, proxied through Cloudflare.
- Managed WAF ruleset + OWASP Core Ruleset for the zone.
- Bot Fight Mode.
- Rate-limiting rules on `/login`, `/signup`, `/api/*`.
- A Turnstile widget for signup CAPTCHA.

Origin-lock (restricting ALB ingress to Cloudflare's edge IPs) is done on the K8s side via `alb.ingress.kubernetes.io/inbound-cidrs`, not here — see `../../../llmsafespaces-ops-prod/kubernetes/apps/llmsafespaces/llmsafespaces/app/helm-release.yaml`.

## Free-tier limitations (discovered 2026-07-02)

If your Cloudflare plan is **Free** on the target zone, several resources in this module will fail at apply time:

1. **`cloudflare_ruleset.zone_ratelimit`** deploys 3 rules with `period: 60` / `mitigation_timeout: 600`. Free tier accepts only 1 rate-limit rule, and it must have `period: 10` and `mitigation_timeout: 10`. Fix: replace `rate-limit.tf` with a single-rule variant (keep only the `/api/v1/auth/login` rule) with those values.

2. **`waf.tf` OWASP Core Ruleset execute rule**. Free tier only exposes the "Cloudflare Managed Free Ruleset" (ID `77454fe2d30c4220b5701f6fdfb893ba` on our zone). Drop the OWASP execute rule; keep the Managed Free Ruleset one.

3. **`bot-fight.tf`**. Free-tier Bot Fight Mode cannot be toggled via any API endpoint accessible to standard tokens — it's dashboard-only. Drop this resource; toggle it manually in the CF dashboard → Security → Bots.

4. **`cloudflare_turnstile_widget`** works, but the site key hasn't been wired into the frontend chart. Emitted as an output; chart-side PR pending.

## Prerequisites

1. **Cloudflare API token** with permissions:
   - `Zone:Zone:Read`
   - `Zone:DNS:Edit`
   - `Zone:Zone Settings:Edit`
   - `Zone:Firewall Services:Edit`
   - `Zone:Zone WAF:Edit`   ← required for `/zones/$ZONE/rulesets` endpoints; separate from `Firewall Services`.
   - `Account:Turnstile Sites:Edit`   ← only if using Turnstile.

   Scope: restrict to zone `thekao.cloud`.

2. **Store the token in AWS Secrets Manager** so Terraform reads it via the AWS provider (avoids checking secrets into env vars):
   ```bash
   aws secretsmanager create-secret --profile mikekao-prod --region us-west-2 \
     --name llmsafespaces/cloudflare-api-token \
     --description 'Cloudflare API token for terraform to manage the llmsafespaces zone' \
     --secret-string 'YOUR_CF_TOKEN'
   ```

3. **Terraform state backend** — a private S3 bucket in the AWS account with versioning + SSE. If you don't already have one, create with:
   ```bash
   aws s3api create-bucket --profile mikekao-prod --region us-west-2 \
     --bucket llmsafespaces-tf-state \
     --create-bucket-configuration LocationConstraint=us-west-2
   aws s3api put-bucket-versioning --profile mikekao-prod --region us-west-2 \
     --bucket llmsafespaces-tf-state --versioning-configuration Status=Enabled
   aws s3api put-bucket-encryption --profile mikekao-prod --region us-west-2 \
     --bucket llmsafespaces-tf-state \
     --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   aws s3api put-public-access-block --profile mikekao-prod --region us-west-2 \
     --bucket llmsafespaces-tf-state \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

4. **Terraform CLI** ≥ 1.9. Recommend the HashiCorp release: <https://developer.hashicorp.com/terraform/install>.

## Usage

```bash
cd ~/llmsafespaces-cdk/terraform/cloudflare

# Populate zone + ALB target. See variables.tf for the schema. Suggested
# workflow is to keep this in an untracked `.tfvars` file:
cat > terraform.tfvars <<EOF
cloudflare_account_id = "REPLACE_WITH_YOUR_CF_ACCOUNT_ID"
zone_name             = "thekao.cloud"
subdomains            = ["safespaces", "grafana.safespaces"]
alb_hostname          = "k8s-llmsafes-llmsafes-2f919186c8-1987193235.us-west-2.elb.amazonaws.com"
EOF

# Init (downloads providers, sets up backend)
terraform init

# Preview
terraform plan -out=cf.plan

# Apply (idempotent; safe to re-run)
terraform apply cf.plan
```

## What gets created (in order of apply)

1. `cloudflare_dns_record` — CNAMEs for each subdomain → `alb_hostname`, proxied through Cloudflare (`proxied = true`).
2. `cloudflare_zone_setting.security_level` — bumps to `medium` (from default).
3. Managed WAF ruleset + OWASP Core Ruleset via `cloudflare_ruleset`.
4. Bot Fight Mode via `cloudflare_zone_setting.bot_management` (free tier features).
5. Rate limiting via a single `cloudflare_ruleset` with `kind=zone, phase=http_ratelimit`:
   - `/login`: 5 requests/60s per IP
   - `/signup`: 3 requests/3600s per IP
   - `/api/*`: 60 requests/60s per IP
6. `cloudflare_turnstile_widget` — signup CAPTCHA. Site key + secret key are output; wire the site key into the chart values (see follow-up in ops-prod repo).

## Outputs

- `turnstile_site_key` — public, safe to bake into the frontend chart.
- `turnstile_secret_key` — sensitive; store in AWS Secrets Manager and wire via an ExternalSecret + chart env var. **The Terraform state contains this in cleartext**, hence the S3 backend + SSE + private bucket requirement.
- `dns_record_ids` — for future imports / audits.

## Runbook: swap Cloudflare edge on/off

To route around Cloudflare (bypass the WAF/rate-limits) in an emergency (e.g. legitimate rate-limit blocking real users):

```bash
# In the Cloudflare dashboard: DNS → click the orange cloud on each
# record → "DNS only" (grey cloud). Traffic then flows directly to
# the ALB without proxy.
#
# BEWARE: this also disables the WAF and Turnstile — traffic hits the
# ALB directly. If you have origin-lock enabled (alb.ingress.kubernetes.io/
# inbound-cidrs restricted to Cloudflare IPs), turning off the proxy also
# breaks all inbound traffic. Do these two things together:
#   1. Remove the inbound-cidrs annotation from the ingress; wait for LBC to reconcile.
#   2. Then flip the DNS records to DNS-only.
```

To re-enable Cloudflare: reverse both steps in reverse order.

## Related

- Cloudflare Terraform provider v5 upgrade guide: <https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/guides/version-5-upgrade>
- Zone Rulesets: <https://developers.cloudflare.com/waf/managed-rules/deploy-zone-dashboard/>
- Rate limiting Rules: <https://developers.cloudflare.com/waf/rate-limiting-rules/>
- Turnstile: <https://developers.cloudflare.com/turnstile/>
- Origin-lock companion: `../../../llmsafespaces-ops-prod/docs/runbooks/alb-origin-lock.md`
