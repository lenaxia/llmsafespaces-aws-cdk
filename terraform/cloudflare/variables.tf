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
  description = "Per-IP request rate limit for POST /api/v1/auth/login. Real users very rarely need more than 5/min."
  type        = number
  default     = 5
}

variable "rate_limit_signup_requests_per_hour" {
  description = "Per-IP request rate limit for POST /api/v1/auth/signup. 3/hr is aggressive but signup is a low-frequency legit action."
  type        = number
  default     = 3
}

variable "rate_limit_api_requests_per_minute" {
  description = "Per-IP request rate limit for the general /api/v1/ path (excluding /login and /signup which have their own more-restrictive limits)."
  type        = number
  default     = 60
}

variable "enable_bot_fight_mode" {
  description = "Toggle Cloudflare Bot Fight Mode (free-tier feature). Set to false during controlled load tests to disable it."
  type        = bool
  default     = true
}
