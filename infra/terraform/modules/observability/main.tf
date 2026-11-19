###############################################################################
# CloudWatch: un log group por microservicio y ambiente
# (/aegisvolt/<env>/<servicio>), métricas derivadas de los logs JSON y la
# alarma que usa el pipeline para decidir si promueve o revierte un canary.
###############################################################################
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "environment" { type = string }
variable "services" { type = list(string) }
variable "retention_days" { type = number }

variable "enable_metric_filters" {
  type    = bool
  default = true
}

locals {
  namespace = "AegisVolt/${var.environment}"
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(concat(var.services, ["prefect"]))
  name              = "/aegisvolt/${var.environment}/${each.value}"
  retention_in_days = var.retention_days
  tags              = { Service = each.value }
}

# --- Métricas a partir de los logs estructurados ---------------------------
locals {
  metric_filters = var.enable_metric_filters ? {
    SagaCompleted          = { group = "graphql-gateway", pattern = "{ $.message = \"saga_completed\" }" }
    SagaCompensated        = { group = "graphql-gateway", pattern = "{ $.message = \"saga_compensated\" }" }
    SagaCompensationFailed = { group = "graphql-gateway", pattern = "{ $.message = \"saga_compensation_failed\" }" }
    CanaryErrors           = { group = "graphql-gateway", pattern = "{ $.track = \"canary\" && $.level = \"error\" }" }
    CanaryRequests         = { group = "graphql-gateway", pattern = "{ $.track = \"canary\" && $.message = \"graphql_operation\" }" }
  } : {}
}

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each       = local.metric_filters
  name           = "${each.key}-${var.environment}"
  log_group_name = aws_cloudwatch_log_group.service[each.value.group].name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "canary_errors" {
  count               = var.enable_metric_filters ? 1 : 0
  alarm_name          = "aegisvolt-${var.environment}-canary-errors"
  alarm_description   = "Errores en pods canary: el pipeline hace rollback si está en ALARM"
  namespace           = local.namespace
  metric_name         = "CanaryErrors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "compensation_failed" {
  count               = var.enable_metric_filters ? 1 : 0
  alarm_name          = "aegisvolt-${var.environment}-saga-compensation-failed"
  alarm_description   = "Una SAGA quedó en COMPENSATION_FAILED: requiere intervención"
  namespace           = local.namespace
  metric_name         = "SagaCompensationFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

output "log_groups" {
  value = { for k, g in aws_cloudwatch_log_group.service : k => g.name }
}
output "metrics_namespace" { value = local.namespace }
