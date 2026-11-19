###############################################################################
# API Gateway (REST) como punto de entrada HTTPS.
#
# AWS real (private_integration = true):
#   Cliente -> API GW -> VPC Link -> NLB interno (subredes privadas)
#           -> NodePort del Service graphql-gateway en EKS -> pod
#   + Endpoint Service (PrivateLink) sobre el NLB y un Interface VPCE que lo
#     consume, para que clientes dentro de la VPC lleguen al clúster sin
#     internet. El API además acepta tráfico desde el VPCE execute-api.
#
# Local (Floci): integración HTTP_PROXY hacia el gateway expuesto en el host.
###############################################################################
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "endpoints_security_group_id" { type = string }

variable "private_integration" {
  description = "true = VPC Link + NLB interno hacia EKS; false = HTTP_PROXY a local_backend_url"
  type        = bool
}

variable "local_backend_url" {
  type    = string
  default = "http://host.docker.internal:4000"
}

variable "k8s_node_port" {
  description = "NodePort del Service graphql-gateway en el clúster"
  type        = number
  default     = 30080
}

# --- NLB interno + PrivateLink hacia Kubernetes (sólo AWS real) -------------
resource "aws_lb" "k8s" {
  count              = var.private_integration ? 1 : 0
  name               = "${var.name}-k8s-nlb"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids
}

resource "aws_lb_target_group" "gateway" {
  count       = var.private_integration ? 1 : 0
  name        = "${var.name}-gql"
  port        = var.k8s_node_port
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  target_type = "instance"
  health_check {
    protocol = "HTTP"
    path     = "/health/ready"
    port     = tostring(var.k8s_node_port)
  }
}

resource "aws_lb_listener" "gateway" {
  count             = var.private_integration ? 1 : 0
  load_balancer_arn = aws_lb.k8s[0].arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway[0].arn
  }
}

resource "aws_vpc_endpoint_service" "k8s" {
  count                      = var.private_integration ? 1 : 0
  acceptance_required        = false
  network_load_balancer_arns = [aws_lb.k8s[0].arn]
  tags                       = { Name = "${var.name}-k8s-endpoint-service" }
}

resource "aws_vpc_endpoint" "k8s" {
  count              = var.private_integration ? 1 : 0
  vpc_id             = var.vpc_id
  service_name       = aws_vpc_endpoint_service.k8s[0].service_name
  vpc_endpoint_type  = "Interface"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [var.endpoints_security_group_id]
  tags               = { Name = "${var.name}-vpce-k8s" }
}

resource "aws_api_gateway_vpc_link" "k8s" {
  count       = var.private_integration ? 1 : 0
  name        = "${var.name}-vpc-link"
  target_arns = [aws_lb.k8s[0].arn]
}

# --- REST API ---------------------------------------------------------------
resource "aws_api_gateway_rest_api" "this" {
  name        = "${var.name}-api"
  description = "AegisVolt GraphQL API (${var.environment})"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
  request_parameters = {
    "method.request.path.proxy" = true
  }
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  type                    = "HTTP_PROXY"
  integration_http_method = "ANY"
  connection_type         = var.private_integration ? "VPC_LINK" : "INTERNET"
  connection_id           = var.private_integration ? aws_api_gateway_vpc_link.k8s[0].id : null
  uri                     = var.private_integration ? "http://${aws_lb.k8s[0].dns_name}/{proxy}" : "${var.local_backend_url}/{proxy}"
  request_parameters = {
    "integration.request.path.proxy" = "method.request.path.proxy"
  }
}

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  triggers = {
    redeploy = sha1(jsonencode([aws_api_gateway_resource.proxy.id, aws_api_gateway_method.proxy.id, aws_api_gateway_integration.proxy.id, aws_api_gateway_integration.proxy.uri]))
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.environment
}

output "rest_api_id" { value = aws_api_gateway_rest_api.this.id }
output "stage" { value = aws_api_gateway_stage.this.stage_name }
output "invoke_url" { value = aws_api_gateway_stage.this.invoke_url }
output "nlb_target_group_arn" { value = try(aws_lb_target_group.gateway[0].arn, null) }
output "k8s_vpce_id" { value = try(aws_vpc_endpoint.k8s[0].id, null) }
