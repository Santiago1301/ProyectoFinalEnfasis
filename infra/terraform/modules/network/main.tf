###############################################################################
# Red privada por ambiente: VPC + subredes públicas/privadas en 2 AZs +
# VPC Endpoints para que el tráfico hacia S3, DynamoDB, CloudWatch, API Gateway
# y ECR/STS nunca salga a internet.
###############################################################################
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "vpc_cidr" { type = string }
variable "azs" { type = list(string) }

variable "enable_nat_gateway" {
  description = "NAT para que los nodos privados descarguen imágenes externas (costoso en AWS real)"
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "Servicios con Interface VPC Endpoint (PrivateLink)"
  type        = list(string)
  default     = ["logs", "monitoring", "execute-api", "ecr.api", "ecr.dkr", "sts"]
}

locals {
  public_subnets  = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i, _ in var.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnets[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags = {
    Name                     = "${var.name}-public-${var.azs[count.index]}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.azs)
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = var.azs[count.index]
  tags = {
    Name                              = "${var.name}-private-${var.azs[count.index]}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Las subredes privadas NO tienen ruta 0.0.0.0/0 hacia el IGW. Sólo salen
# por NAT (opcional) o, para servicios AWS, por los VPC Endpoints.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-rt-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat-eip" }
}

resource "aws_nat_gateway" "this" {
  count         = var.enable_nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.name}-nat" }
}

resource "aws_route" "private_nat" {
  count                  = var.enable_nat_gateway ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

# ---------------------------------------------------------------------------
# Gateway Endpoints (S3, DynamoDB): agregan una ruta con prefix-list en la
# tabla de rutas privada. Gratis y sin ENIs.
# ---------------------------------------------------------------------------
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${var.name}-vpce-s3" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  # Sólo permite operar sobre las tablas de ESTE ambiente.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = "*"
      Action    = "dynamodb:*"
      Resource = [
        "arn:aws:dynamodb:${var.region}:*:table/aegisvolt-*-${var.environment}",
        "arn:aws:dynamodb:${var.region}:*:table/aegisvolt-*-${var.environment}/*",
      ]
    }]
  })
  tags = { Name = "${var.name}-vpce-dynamodb" }
}

# ---------------------------------------------------------------------------
# Interface Endpoints (PrivateLink): ENIs en subredes privadas protegidas por
# un Security Group que sólo acepta HTTPS desde la propia VPC.
# ---------------------------------------------------------------------------
resource "aws_security_group" "endpoints" {
  name        = "${var.name}-vpce-sg"
  description = "HTTPS desde la VPC hacia los Interface Endpoints"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS desde la VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name}-vpce-sg" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(var.interface_endpoint_services)
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-vpce-${replace(each.value, ".", "-")}" }
}

output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = aws_vpc.this.cidr_block }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "private_route_table_id" { value = aws_route_table.private.id }
output "endpoints_security_group_id" { value = aws_security_group.endpoints.id }
output "vpc_endpoint_ids" {
  value = merge(
    { s3 = aws_vpc_endpoint.s3.id, dynamodb = aws_vpc_endpoint.dynamodb.id },
    { for k, v in aws_vpc_endpoint.interface : k => v.id },
  )
}
output "execute_api_vpce_id" {
  value = try(aws_vpc_endpoint.interface["execute-api"].id, null)
}
