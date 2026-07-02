# Bot Fight Mode — free-tier feature that challenges (JS/interstitial)
# requests from IPs on Cloudflare's low-reputation list.
#
# Managed via the zone_setting resource; unlike Super Bot Fight Mode
# (paid), no per-endpoint tuning.
resource "cloudflare_zone_setting" "bot_fight_mode" {
  count = var.enable_bot_fight_mode ? 1 : 0

  zone_id    = data.cloudflare_zone.this.zone_id
  setting_id = "bot_management"
  value = jsonencode({
    fight_mode = true
  })
}
