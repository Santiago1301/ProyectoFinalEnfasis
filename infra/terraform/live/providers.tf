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
      apigateway = var.emulator_endpoint
      cloudwatch = var.emulator_endpoint
      logs       = var.emulator_endpoint
      dynamodb   = var.emulator_endpoint
      ec2        = var.emulator_endpoint
      eks        = var.emulator_endpoint
      elbv2      = var.emulator_endpoint
      iam        = var.emulator_endpoint
      s3         = var.emulator_endpoint
      sts        = var.emulator_endpoint
    }
  }

  default_tags {
    tags = {
      Project     = "aegisvolt"
      Environment = local.env
      ManagedBy   = "terraform"
      Workspace   = terraform.workspace
    }
  }
}

provider "kubernetes" {
  config_path    = var.manage_kubernetes ? pathexpand(var.kube_config_path) : null
  config_context = var.manage_kubernetes ? var.kube_context : null
}
