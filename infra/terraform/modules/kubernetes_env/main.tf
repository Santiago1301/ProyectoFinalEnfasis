###############################################################################
# Namespace + configuración por ambiente dentro del clúster. Los manifiestos
# de los microservicios leen este ConfigMap, así la misma imagen se comporta
# como dev, test o prod sólo según el namespace donde corre.
###############################################################################
terraform {
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes" }
  }
}

variable "environment" { type = string }
variable "table_names" { type = map(string) }
variable "aws_region" { type = string }
variable "aws_endpoint_url" {
  description = "Endpoint de AWS visto desde los pods (Floci en local, vacío en AWS real)"
  type        = string
  default     = ""
}
variable "pods_role_arn" {
  type    = string
  default = ""
}
variable "allow_flag_mutations" { type = bool }

locals {
  namespace = "aegisvolt-${var.environment}"
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name   = local.namespace
    labels = { "app.kubernetes.io/part-of" = "aegisvolt", environment = var.environment }
  }
}

resource "kubernetes_config_map_v1" "config" {
  metadata {
    name      = "aegisvolt-config"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  data = merge(
    {
      AEGIS_ENV               = var.environment
      AWS_REGION              = var.aws_region
      CLOUDWATCH_LOGS_ENABLED = "true"
      ALLOW_FLAG_MUTATIONS    = tostring(var.allow_flag_mutations)
      RESERVATION_SERVICE_URL = "http://station-reservation-service"
      BILLING_SERVICE_URL     = "http://billing-wallet-service"
      DISPATCH_SERVICE_URL    = "http://energy-dispatch-service"
      TABLE_RESERVATIONS      = var.table_names["reservations"]
      TABLE_BILLING           = var.table_names["billing"]
      TABLE_DISPATCH          = var.table_names["dispatch"]
      TABLE_SAGAS             = var.table_names["sagas"]
      TABLE_FEATURE_FLAGS     = var.table_names["feature-flags"]
    },
    var.aws_endpoint_url == "" ? {} : { AWS_ENDPOINT_URL = var.aws_endpoint_url },
  )
}

# En local Floci acepta cualquier credencial; en AWS real se usa IRSA.
resource "kubernetes_secret_v1" "aws" {
  count = var.aws_endpoint_url == "" ? 0 : 1
  metadata {
    name      = "aegisvolt-aws"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  data = {
    AWS_ACCESS_KEY_ID     = "test"
    AWS_SECRET_ACCESS_KEY = "test"
  }
}

resource "kubernetes_service_account_v1" "app" {
  metadata {
    name        = "aegisvolt"
    namespace   = kubernetes_namespace_v1.this.metadata[0].name
    annotations = var.pods_role_arn == "" ? {} : { "eks.amazonaws.com/role-arn" = var.pods_role_arn }
  }
}

output "namespace" { value = local.namespace }
