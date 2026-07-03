variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Find under the dashboard → your account → Account ID."
  type        = string
}

variable "zone_name" {
  description = "The Cloudflare zone (apex domain) that hosts the app subdomains, e.g. thekao.cloud."
  type        = string
}

variable "subdomains" {
  description = <<EOT
Subdomains (relative to zone_name) that should be CNAME'd to the ALB and proxied through Cloudflare.
Example: ["safespaces", "grafana.safespaces"] on zone thekao.cloud creates:
  safespaces.thekao.cloud       → alb_hostname (proxied)
  grafana.safespaces.thekao.cloud → alb_hostname (proxied)
EOT
  type    = list(string)
  default = ["safespaces", "grafana.safespaces"]
}

variable "alb_hostname" {
  description = "AWS ALB DNS name (the k8s-...-elb.amazonaws.com hostname). Get it from `kubectl get ingress -A -o wide`."
  type        = string
}

variable "turnstile_domains" {
  description = "Domains the Turnstile widget will validate signatures for. Typically the same as the subdomain FQDNs above."
  type        = list(string)
  default     = ["safespaces.thekao.cloud"]
}

variable "rate_limit_login_requests_per_minute" {
  description = <<EOT
Per-IP request rate limit for POST /api/v1/auth/login. Real users very rarely need more than 5/min.

FREE-TIER CAVEAT (discovered 2026-07-02): Cloudflare Free plan only allows period=10s (not 60s) and only 1 rate-limit rule per zone. If the target zone is Free, use rate-limit.tf's single-rule variant with period=10 requests_per_period=5 mitigation_timeout=10.
EOT
  type    = number
  default = 5
}

variable "rate_limit_signup_requests_per_hour" {
  description = <<EOT
Per-IP request rate limit for POST /api/v1/auth/signup. 3/hr is aggressive but signup is a low-frequency legit action.

FREE-TIER CAVEAT: unused on Free plan (only 1 rate-limit rule available; login takes the slot).
EOT
  type    = number
  default = 3
}

variable "rate_limit_api_requests_per_minute" {
  description = <<EOT
Per-IP request rate limit for the general /api/v1/ path (excluding /login and /signup which have their own more-restrictive limits).

FREE-TIER CAVEAT: unused on Free plan (only 1 rate-limit rule available).
EOT
  type    = number
  default = 60
}

variable "enable_bot_fight_mode" {
  description = <<EOT
Toggle Cloudflare Bot Fight Mode. Set to false during controlled load tests to disable it.

FREE-TIER CAVEAT: On Free plan, Bot Fight Mode is dashboard-only — no API endpoint accepts writes. This variable is ignored on Free; toggle manually in CF dashboard → Security → Bots.
EOT
  type    = bool
  default = true
}
