/**
 * Outputs are for wiring the deploy, not for reading data out of the estate.
 *
 * Nothing here is sensitive on purpose: the database password and the auth
 * secret live in Secrets Manager and are read by ECS, never emitted. An output
 * marked `sensitive` is still written to state in clear text, and state is a
 * file that ends up on laptops.
 */

output "api_url" {
  description = "Point the API's DNS record here."
  value       = aws_lb.main.dns_name
}

output "ecr_repository_url" {
  description = "Push the image here; deploy by passing its tag as image_tag."
  value       = aws_ecr_repository.api.repository_url
}

output "documents_bucket" {
  description = "S3_BUCKET for the API and worker."
  value       = aws_s3_bucket.documents.id
}

output "kms_key_arn" {
  description = "S3_KMS_KEY_ID. S3DocumentStorage refuses to construct without it."
  value       = aws_kms_key.main.arn
}

output "database_endpoint" {
  description = "For running migrations from a bastion or a one-off task."
  value       = aws_db_instance.main.endpoint
}

/**
 * The secrets a human has to fill in before the API will boot.
 *
 * `assertProductionReady` refuses to start production without the Twilio token
 * and the alert webhook, so this is the shortest path from `terraform apply`
 * to a service that actually comes up.
 */
output "secrets_to_populate" {
  description = "§13 Day-0 — set these out-of-band; Terraform creates them empty."
  value       = [for secret in aws_secretsmanager_secret.vendor : secret.name]
}
