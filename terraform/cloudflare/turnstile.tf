# Turnstile widget for signup CAPTCHA.
#
# The widget's site key is public — bake into the frontend chart.
# The secret key is server-side — stored in AWS Secrets Manager for
# the API pod to consume via an ExternalSecret (see follow-up in
# lenaxia/llmsafespaces-ops-prod).
#
# `mode = "managed"` picks between interactive/invisible/JS challenges
# automatically. `bot_fight_mode = "non_interactive"` keeps the flow
# invisible for well-behaved browsers.

resource "cloudflare_turnstile_widget" "signup" {
  account_id = var.cloudflare_account_id
  name       = "llmsafespaces signup"
  domains    = var.turnstile_domains
  mode       = "managed"
  # `region = "world"` (default) is fine for a globally-available signup.
  # Bounding to a specific set of regions is only useful for enterprise
  # accounts blocking specific countries.
  region = "world"

  # Log a hint to check the widget on the CF dashboard for its
  # analytics / issued-token count.
  offlabel = false
}

# Store the widget secret key in AWS Secrets Manager so the API pod can
# consume it via ExternalSecret. Marked as sensitive; won't appear in
# terraform plan output.
resource "aws_secretsmanager_secret" "turnstile_secret" {
  name                    = "llmsafespaces/turnstile-secret"
  description             = "Cloudflare Turnstile secret key (server-side verification token)"
  recovery_window_in_days = 7

  tags = {
    "llmsafespaces:role" = "app-secret" # Read by external-secrets IRSA role.
    project              = "llmsafespaces"
    "managed-by"         = "terraform"
  }
}

resource "aws_secretsmanager_secret_version" "turnstile_secret_v" {
  secret_id     = aws_secretsmanager_secret.turnstile_secret.id
  secret_string = cloudflare_turnstile_widget.signup.secret
}
