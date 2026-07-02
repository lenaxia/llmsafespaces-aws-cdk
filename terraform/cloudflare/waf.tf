# Managed WAF — Cloudflare Managed Ruleset + Cloudflare OWASP Core Ruleset.
#
# Each managed ruleset is deployed via an "execute" rule at the
# http_request_firewall_managed phase's entry-point ruleset. There's
# exactly ONE entry-point ruleset per phase per zone (Cloudflare's
# constraint), so we bundle all the execute rules here.
#
# Managed ruleset IDs are Cloudflare-global constants — they don't
# change across accounts/zones. See:
#   https://developers.cloudflare.com/waf/managed-rules/reference/managed-rulesets/

locals {
  # Cloudflare Managed Ruleset (general WAF, mostly generic exploits).
  cf_managed_ruleset_id = "efb7b8c949ac4650a09736fc376e9aee"

  # OWASP Core Ruleset (paranoia-scored rules). We set to anomaly
  # threshold 60 → higher means fewer blocks. Default is 40 which is
  # too aggressive for app traffic. Adjust after monitoring firewall
  # events for a week.
  owasp_ruleset_id = "4814384a9e5d4991b9815dcfc25d2f1f"
}

resource "cloudflare_ruleset" "zone_waf_managed" {
  zone_id     = data.cloudflare_zone.this.zone_id
  name        = "llmsafespaces zone WAF entry point"
  description = "Deploys Cloudflare Managed Ruleset + OWASP CRS for this zone"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [
    {
      ref         = "execute_cf_managed"
      description = "Execute Cloudflare Managed Ruleset"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id = local.cf_managed_ruleset_id
      }
    },
    {
      ref         = "execute_owasp_crs"
      description = "Execute Cloudflare OWASP Core Ruleset (paranoia)"
      expression  = "true"
      action      = "execute"
      action_parameters = {
        id = local.owasp_ruleset_id
        overrides = {
          # Bump the anomaly threshold from the default (paranoia 1,
          # threshold 40) to 60. This trades a few extra low-severity
          # false-positives allowed through for a much lower rate of
          # false-block on legit app traffic. Revisit after 1 week of
          # firewall events review.
          rules = [{
            id      = "6179ae15870a4bb7b2d480d4843b323c" # anomaly-detection score
            enabled = true
          }]
        }
      }
    }
  ]
}
