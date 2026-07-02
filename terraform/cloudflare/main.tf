# Provider and backend wiring.
#
# The Cloudflare provider reads its API token from AWS Secrets Manager.
# This avoids CF_API_TOKEN sitting in shell env / tfvars files.
#
# The state backend is a private S3 bucket in the mikekao-prod account
# with versioning + SSE. Bucket name is fixed here; the AWS profile
# used to access it defaults to whatever AWS_PROFILE the operator has
# set (typically `mikekao-prod`).

terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.75"
    }
  }

  backend "s3" {
    bucket  = "llmsafespaces-tf-state"
    key     = "cloudflare/terraform.tfstate"
    region  = "us-west-2"
    encrypt = true
    # DynamoDB locking omitted for a single-operator personal deploy.
    # If this ever grows to a team, add:
    #   dynamodb_table = "llmsafespaces-tf-locks"
  }
}

provider "aws" {
  region = "us-west-2"
}

# Pull the Cloudflare API token from Secrets Manager. Precondition:
# operator has already run `aws secretsmanager create-secret --name
# llmsafespaces/cloudflare-api-token ...` — see README.
data "aws_secretsmanager_secret_version" "cf_token" {
  secret_id = "llmsafespaces/cloudflare-api-token"
}

provider "cloudflare" {
  api_token = data.aws_secretsmanager_secret_version.cf_token.secret_string
}

# Look up zone ID from zone_name so operators don't have to paste a
# UUID into terraform.tfvars.
data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}
