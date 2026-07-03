# Bot Fight Mode — free-tier feature that challenges (JS/interstitial)
# requests from IPs on Cloudflare's low-reputation list.
#
# Managed via the zone_setting resource; unlike Super Bot Fight Mode
# (paid), no per-endpoint tuning.
#
# FREE-TIER CAVEAT (discovered 2026-07-02): despite Cloudflare docs
# calling this a "free-tier feature", the setting_id below fails with:
#   /zones/$ZONE/bot_management: HTTP 403 "Authentication error" (code 10000)
#   /zones/$ZONE/settings/bot_fight_mode: HTTP 400 "Undefined zone setting" (code 1003)
# Even with a token that has Zone:Zone Settings:Edit + Zone:Firewall:Edit +
# Zone WAF:Edit. Only the dashboard UI toggle works on Free plan.
# For Free-tier zones, this resource will fail at apply time — delete
# from the module or set enable_bot_fight_mode=false and toggle in
# the CF dashboard: Security → Bots → Bot Fight Mode → On.
resource "cloudflare_zone_setting" "bot_fight_mode" {
  count = var.enable_bot_fight_mode ? 1 : 0

  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "bot_management"
  value = jsonencode({
    fight_mode = true
  })
}
