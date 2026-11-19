# Estado remoto en el S3 emulado por Floci (bucket creado por ../bootstrap).
bucket       = "aegisvolt-tfstate"
key          = "aegisvolt/terraform.tfstate"
region       = "us-east-1"
encrypt      = true
use_lockfile = true # bloqueo nativo de S3 (archivo .tflock), sin tabla DynamoDB

access_key                  = "test"
secret_key                  = "test"
use_path_style              = true
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
endpoints = {
  s3 = "http://localhost:4566"
}
