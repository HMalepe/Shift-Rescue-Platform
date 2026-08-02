/**
 * §10 — data residency is a variable with one sensible value, not a free choice.
 *
 * af-south-1 is Cape Town. Personal information under POPIA can leave South
 * Africa, but only under conditions (§72) that mean legal work per destination.
 * Keeping the data in-country avoids the question entirely, and the question is
 * one of the five §13 Day-0 legal items — so a default that quietly moves an
 * ID document to Ireland is a default that creates work nobody asked for.
 *
 * Validated rather than commented, because a comment does not stop a `-var`.
 */
variable "region" {
  description = "AWS region. Must be af-south-1 unless a POPIA §72 transfer basis exists."
  type        = string
  default     = "af-south-1"

  validation {
    condition     = var.region == "af-south-1"
    error_message = "Personal information stays in South Africa (POPIA). Changing this needs a §72 transfer basis and sign-off, not a -var."
  }
}

variable "environment" {
  description = "Environment name; part of every resource name."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

/*
 * Two AZs, not three.
 *
 * RDS Multi-AZ needs two. A third buys very little for a single-region
 * marketplace serving greater Johannesburg, and af-south-1 charges for every
 * NAT gateway and cross-AZ byte. Named explicitly rather than taken from a
 * data source so a provider update cannot silently move the subnets.
 */
variable "availability_zones" {
  description = "AZs to spread subnets across."
  type        = list(string)
  default     = ["af-south-1a", "af-south-1b"]
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage. Autoscaling handles growth up to the max."
  type        = number
  default     = 50
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

/*
 * §10 — how long a document survives after the person is gone.
 *
 * The erasure endpoint anonymises the row immediately; this is the backstop for
 * the object itself. Seven years matches the retention decision in
 * packages/core/src/privacy/retention.ts for employment records, and the two
 * must not drift — RETENTION_POLICY is asserted against the schema in code,
 * but nothing asserts it against this bucket.
 */
variable "document_retention_days" {
  description = "Days before a verification document is expired from S3."
  type        = number
  default     = 2555 # 7 years
}

variable "alert_email" {
  description = "§0.1 — where budget and infrastructure alarms go."
  type        = string
}

/**
 * §13 Day-0: the certificate and the domain.
 *
 * Passed in rather than created here because an ACM certificate needs DNS
 * validation on a zone that does not exist yet, and a half-validated
 * certificate blocks every apply until someone clicks through a registrar.
 */
variable "certificate_arn" {
  description = "ACM certificate for the API domain. Must be in the same region as the ALB."
  type        = string
}

variable "public_base_url" {
  description = "https://api.<domain>. Twilio signs the full request URL, so this must be exact."
  type        = string

  validation {
    condition     = startswith(var.public_base_url, "https://")
    error_message = "PUBLIC_BASE_URL must be https — assertProductionReady refuses to boot otherwise."
  }
}

/**
 * The image tag to deploy. No default: `latest` is not a deployment, it is a
 * question about when the task happened to start.
 */
variable "image_tag" {
  description = "Immutable image tag (a commit SHA)."
  type        = string
}

variable "monthly_budget_usd" {
  description = "§0.1 — monthly spend that triggers a notification, not a shutdown."
  type        = string
  default     = "400"
}
