# Zone-wide security settings — the free-tier defaults are lax; we bump
# them to `medium` and enable Bot Fight Mode.
#
# Cloudflare v5 provider expresses zone-level settings via the
# cloudflare_zone_setting resource (one per setting).

resource "cloudflare_zone_setting" "security_level" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "security_level"
  # Options: "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack".
  # `medium` catches most low-reputation IPs without hitting real users.
  value = "medium"
}

# Enforce HTTPS at the edge — HTTP requests get 301'd to HTTPS.
resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

# Minimum TLS version — reject clients trying to connect with TLS < 1.2.
resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

# Automatic HTTPS Rewrites — bumps any `http://` link served by our
# origin to `https://` at the edge.
resource "cloudflare_zone_setting" "automatic_https_rewrites" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "automatic_https_rewrites"
  value      = "on"
}

# Browser Integrity Check — CF drops requests missing common browser
# headers, which many botnets omit.
resource "cloudflare_zone_setting" "browser_check" {
  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "browser_check"
  value      = "on"
}
