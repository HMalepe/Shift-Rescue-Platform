/**
 * Secrets.
 *
 * Terraform creates the containers; the VALUES are set out-of-band and are not
 * in this repository or in state. Two of them cannot be known here at all —
 * the Twilio auth token and the Payfast passphrase are §13 Day-0 items that do
 * not exist until someone opens those accounts.
 *
 * `ignore_changes` on the value is what makes that arrangement stable. Without
 * it, every apply would reset a rotated secret back to whatever Terraform last
 * knew, which is the kind of outage that looks like the vendor's fault.
 */

resource "random_password" "auth_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "auth" {
  name        = "${local.name}/auth-secret"
  description = "Access-token signing key. Rotating it invalidates every issued token."
  kms_key_id  = aws_kms_key.main.arn

  # Long enough to undo a mistake, short enough not to keep a live signing key
  # in a recoverable state indefinitely.
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "auth" {
  secret_id     = aws_secretsmanager_secret.auth.id
  secret_string = random_password.auth_secret.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name        = "${local.name}/database-url"
  description = "Postgres connection string for the API and worker."
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgresql://%s:%s@%s/%s?sslmode=require",
    aws_db_instance.main.username,
    random_password.database.result,
    aws_db_instance.main.endpoint,
    aws_db_instance.main.db_name,
  )

  lifecycle {
    ignore_changes = [secret_string]
  }
}

/*
 * Vendor credentials: created empty, filled in by a human.
 *
 * §15 lists all three as externally blocked. An empty secret is honest about
 * that; a placeholder value would let the API boot and fail on the first real
 * request, which for the Twilio token specifically means webhook signature
 * validation being skipped rather than failing — `assertProductionReady`
 * refuses to boot without it for exactly that reason.
 */
resource "aws_secretsmanager_secret" "vendor" {
  for_each = toset([
    "twilio-auth-token",
    "payfast-passphrase",
    "payfast-merchant-key",
    "alert-webhook-url",
  ])

  name        = "${local.name}/${each.key}"
  description = "Set out-of-band. §13 Day-0."
  kms_key_id  = aws_kms_key.main.arn

  recovery_window_in_days = 7
}
