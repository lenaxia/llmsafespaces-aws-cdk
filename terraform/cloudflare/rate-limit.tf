# Rate-limiting rules at the zone level.
#
# Cloudflare requires all rate-limit rules for a phase to live in a
# single ruleset (the http_ratelimit entry-point ruleset). We define
# 3 rules, listed most-specific-first because Cloudflare evaluates
# them in order and stops at the first match.
#
# Characteristics: [cf.colo.id, ip.src] means "per IP per colo" — the
# cf.colo.id term prevents anycast smearing where two requests from
# the same IP land on different edges and each thinks it saw only one.
resource "cloudflare_ruleset" "zone_ratelimit" {
  zone_id     = data.cloudflare_zone.this.zone_id
  name        = "llmsafespaces rate limits"
  description = "Zone-level rate limiting entry point"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    # /login: 5 req/60s per IP. Real users need 1 successful request;
    # 5 gives room for typos. Blocks credential-stuffing without
    # hitting normal users.
    {
      ref         = "rl_login"
      description = "Rate limit POST /api/v1/auth/login by IP"
      expression  = "(http.request.uri.path eq \"/api/v1/auth/login\") and (http.request.method eq \"POST\")"
      action      = "block"
      action_parameters = {
        response = {
          status_code  = 429
          content      = "{\"error\":\"rate_limited\",\"retry_after_seconds\":60}"
          content_type = "application/json"
        }
      }
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.rate_limit_login_requests_per_minute
        mitigation_timeout  = 600
      }
    },

    # /signup: 3 req/hour per IP. Signup is a rare legit action; 3/hr
    # per IP is a soft cap that stops automated account creation while
    # allowing families/offices sharing a NAT to sign up each member.
    {
      ref         = "rl_signup"
      description = "Rate limit POST /api/v1/auth/signup by IP"
      expression  = "(http.request.uri.path eq \"/api/v1/auth/signup\") and (http.request.method eq \"POST\")"
      action      = "block"
      action_parameters = {
        response = {
          status_code  = 429
          content      = "{\"error\":\"rate_limited\",\"retry_after_seconds\":3600}"
          content_type = "application/json"
        }
      }
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 3600
        requests_per_period = var.rate_limit_signup_requests_per_hour
        mitigation_timeout  = 3600
      }
    },

    # /api/v1/*: 60 req/60s per IP (excluding /login and /signup).
    # This catches abusive scripted access to the API without hitting
    # normal browser traffic which stays under 60 req/min on a hot page.
    #
    # NB: the WebSocket upgrade for the terminal endpoint counts as one
    # request. Long-lived WS connections shouldn't trip this.
    {
      ref         = "rl_api_general"
      description = "Rate limit general /api/v1/* by IP"
      expression  = "(http.request.uri.path matches \"^/api/v1/\") and not (http.request.uri.path in {\"/api/v1/auth/login\" \"/api/v1/auth/signup\"})"
      action      = "block"
      action_parameters = {
        response = {
          status_code  = 429
          content      = "{\"error\":\"rate_limited\"}"
          content_type = "application/json"
        }
      }
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = 60
        requests_per_period = var.rate_limit_api_requests_per_minute
        mitigation_timeout  = 60
      }
    },
  ]
}
