output "zone_id" {
  description = "Cloudflare zone ID (echo of the lookup for reference in other tools)."
  value       = data.cloudflare_zone.this.zone_id
}

output "dns_record_ids" {
  description = "Map of subdomain → DNS record ID."
  value       = { for k, r in cloudflare_dns_record.app : k => r.id }
}

output "turnstile_site_key" {
  description = "Public Turnstile site key. Bake into the frontend chart values so signup renders the widget."
  value       = cloudflare_turnstile_widget.signup.id
}

output "turnstile_secret_arn" {
  description = "ARN of the AWS Secrets Manager secret holding the Turnstile secret key. Wire into external-secrets ExternalSecret."
  value       = aws_secretsmanager_secret.turnstile_secret.arn
}

output "waf_ruleset_id" {
  description = "ID of the zone WAF entry-point ruleset (for audit / manual queries)."
  value       = cloudflare_ruleset.zone_waf_managed.id
}

output "ratelimit_ruleset_id" {
  description = "ID of the zone rate-limit entry-point ruleset."
  value       = cloudflare_ruleset.zone_ratelimit.id
}
