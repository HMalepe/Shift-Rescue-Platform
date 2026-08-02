terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  /*
   * State lives in S3 with a DynamoDB lock table, both created out-of-band.
   *
   * Deliberately not managed by this configuration: a state backend that
   * Terraform also destroys is a configuration that can delete its own record
   * of what exists. Bootstrap it once by hand, then never think about it.
   *
   * Left as a partial backend so the bucket name is supplied at init time
   * (`terraform init -backend-config=...`) rather than hard-coded here, where
   * it would be wrong for every environment but one.
   */
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "locum-planner"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
