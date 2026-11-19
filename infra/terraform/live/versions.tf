terraform {
  required_version = ">= 1.10"

  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.36" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
  }

  # Backend parcial: bucket/endpoint se pasan con -backend-config=backend-<modo>.hcl
  # Con workspaces, el estado de cada ambiente queda en:
  #   s3://aegisvolt-tfstate/env:/<workspace>/aegisvolt/terraform.tfstate
  backend "s3" {}
}
