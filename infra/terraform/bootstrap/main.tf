###############################################################################
# Bootstrap: bucket S3 que almacena el estado remoto de Terraform.
# Se aplica UNA sola vez (estado local, problema del huevo y la gallina).
# Versionamiento habilitado => cada `terraform apply` deja una versión previa
# de env:/<workspace>/aegisvolt/terraform.tfstate recuperable.
###############################################################################
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "use_local_emulator" {
  description = "true = Floci en localhost:4566; false = AWS real"
  type        = bool
  default     = true
}

variable "emulator_endpoint" {
  type    = string
  default = "http://localhost:4566"
}

variable "state_bucket_name" {
  type    = string
  default = "aegisvolt-tfstate"
}

provider "aws" {
  region                      = var.region
  access_key                  = var.use_local_emulator ? "test" : null
  secret_key                  = var.use_local_emulator ? "test" : null
  skip_credentials_validation = var.use_local_emulator
  skip_requesting_account_id  = var.use_local_emulator
  skip_metadata_api_check     = var.use_local_emulator
  s3_use_path_style           = var.use_local_emulator

  dynamic "endpoints" {
    for_each = var.use_local_emulator ? [1] : []
    content {
      s3  = var.emulator_endpoint
      sts = var.emulator_endpoint
    }
  }

  default_tags {
    tags = { Project = "aegisvolt", ManagedBy = "terraform", Stack = "bootstrap" }
  }
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Conserva 90 días las versiones anteriores del estado (backups históricos).
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    id     = "retain-noncurrent-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
  depends_on = [aws_s3_bucket_versioning.tfstate]
}

output "state_bucket" {
  value = aws_s3_bucket.tfstate.bucket
}
