# DNS records for the app subdomains.
#
# Each subdomain from var.subdomains is a CNAME to var.alb_hostname
# with Cloudflare proxy ENABLED (orange cloud). That means:
#   - TLS termination happens at Cloudflare's edge (using CF's cert,
#     not ours). Our ACM cert on the ALB is used for the CF->ALB hop.
#   - Requests reach the ALB with a Cloudflare source IP; the real
#     client IP is in the CF-Connecting-IP header (the AWS LBC's ALB
#     access logs record it separately).
#   - Bot Fight Mode, WAF, and rate-limits can inspect the traffic.
#
# TTL is Cloudflare-managed when proxied=true (`ttl = 1` means auto).
resource "cloudflare_dns_record" "app" {
  for_each = toset(var.subdomains)

  zone_id = data.cloudflare_zone.this.zone_id
  name    = "${each.value}.${var.zone_name}"
  content = var.alb_hostname
  type    = "CNAME"
  ttl     = 1
  proxied = true
  comment = "Managed by terraform: ${path.module}"
}
