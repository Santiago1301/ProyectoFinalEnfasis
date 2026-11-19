###############################################################################
# Database-per-Service: cada microservicio es dueño de su tabla y ningún otro
# servicio la lee/escribe directamente. Todas llevan el sufijo del workspace
# (aegisvolt-<tabla>-<env>), así dev/test/prod nunca colisionan.
###############################################################################
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "environment" { type = string }

variable "point_in_time_recovery" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = false
}

variable "feature_flags" {
  description = "Estado inicial de las feature flags de ESTE ambiente"
  type = map(object({
    enabled     = bool
    description = string
  }))
}

variable "seed_data" {
  description = "Cargar electrolineras y billeteras de ejemplo"
  type        = bool
  default     = true
}

locals {
  tables = {
    # owner = microservicio dueño de la tabla
    reservations  = { hash_key = "pk", range_key = "sk", owner = "station-reservation-service" }
    billing       = { hash_key = "pk", range_key = "sk", owner = "billing-wallet-service" }
    dispatch      = { hash_key = "pk", range_key = "sk", owner = "energy-dispatch-service" }
    sagas         = { hash_key = "sagaId", range_key = null, owner = "graphql-gateway" }
    feature-flags = { hash_key = "name", range_key = null, owner = "platform" }
  }
}

resource "aws_dynamodb_table" "this" {
  for_each = local.tables

  name                        = "aegisvolt-${each.key}-${var.environment}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = each.value.hash_key
  range_key                   = each.value.range_key
  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = each.value.hash_key
    type = "S"
  }

  dynamic "attribute" {
    for_each = each.value.range_key == null ? [] : [each.value.range_key]
    content {
      name = attribute.value
      type = "S"
    }
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Name    = "aegisvolt-${each.key}-${var.environment}"
    Service = each.value.owner
  }
}

# ---------------------------------------------------------------------------
# Feature flags: un ítem por flag en la tabla del ambiente. ignore_changes
# evita que un `terraform apply` revierta un cambio hecho en caliente desde
# la UI/CLI (la flag es estado operativo, Terraform sólo la siembra).
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table_item" "flag" {
  for_each   = var.feature_flags
  table_name = aws_dynamodb_table.this["feature-flags"].name
  hash_key   = "name"

  item = jsonencode({
    name        = { S = each.key }
    enabled     = { BOOL = each.value.enabled }
    description = { S = each.value.description }
    environment = { S = var.environment }
    updatedBy   = { S = "terraform" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

# ---------------------------------------------------------------------------
# Datos semilla: electrolineras/conectores y billeteras de flotas.
# ---------------------------------------------------------------------------
locals {
  stations = {
    "bog-norte"    = { name = "AegisVolt Bogotá Norte", city = "Bogotá", address = "Autopista Norte #170-20", lat = 4.7569, lng = -74.0451 }
    "bog-zf"       = { name = "AegisVolt Zona Franca", city = "Bogotá", address = "Calle 13 #105-60", lat = 4.6683, lng = -74.1503 }
    "med-poblado"  = { name = "AegisVolt El Poblado", city = "Medellín", address = "Carrera 43A #7-50", lat = 6.2088, lng = -75.5679 }
    "cdmx-vallejo" = { name = "AegisVolt Vallejo Hub", city = "Ciudad de México", address = "Av. Poniente 140 #720", lat = 19.4890, lng = -99.1590 }
  }
  connectors = {
    "bog-norte#c1"    = { station = "bog-norte", power = 350, plug = "CCS2", ultra = true }
    "bog-norte#c2"    = { station = "bog-norte", power = 150, plug = "CCS2", ultra = true }
    "bog-norte#c3"    = { station = "bog-norte", power = 50, plug = "CHAdeMO", ultra = false }
    "bog-zf#c1"       = { station = "bog-zf", power = 150, plug = "CCS2", ultra = true }
    "bog-zf#c2"       = { station = "bog-zf", power = 50, plug = "CCS2", ultra = false }
    "bog-zf#c3"       = { station = "bog-zf", power = 22, plug = "Type2", ultra = false }
    "med-poblado#c1"  = { station = "med-poblado", power = 150, plug = "CCS2", ultra = true }
    "med-poblado#c2"  = { station = "med-poblado", power = 50, plug = "CCS2", ultra = false }
    "cdmx-vallejo#c1" = { station = "cdmx-vallejo", power = 350, plug = "CCS1", ultra = true }
    "cdmx-vallejo#c2" = { station = "cdmx-vallejo", power = 150, plug = "CCS1", ultra = true }
    "cdmx-vallejo#c3" = { station = "cdmx-vallejo", power = 50, plug = "CCS1", ultra = false }
  }
  wallets = {
    "fleet-rappi"     = { name = "Rappi Last-Mile EV", balance = 2500000 }
    "fleet-mercadoev" = { name = "MercadoEnvíos Eléctrico", balance = 1200000 }
    # Saldo bajo a propósito: demuestra la compensación por fondos insuficientes (paso 2).
    "fleet-startup" = { name = "Startup Logística (saldo bajo)", balance = 8000 }
  }
}

resource "aws_dynamodb_table_item" "station" {
  for_each   = var.seed_data ? local.stations : {}
  table_name = aws_dynamodb_table.this["reservations"].name
  hash_key   = "pk"
  range_key  = "sk"
  item = jsonencode({
    pk        = { S = "STATION#${each.key}" }
    sk        = { S = "META" }
    name      = { S = each.value.name }
    city      = { S = each.value.city }
    address   = { S = each.value.address }
    latitude  = { N = tostring(each.value.lat) }
    longitude = { N = tostring(each.value.lng) }
  })
}

resource "aws_dynamodb_table_item" "connector" {
  for_each   = var.seed_data ? local.connectors : {}
  table_name = aws_dynamodb_table.this["reservations"].name
  hash_key   = "pk"
  range_key  = "sk"
  item = jsonencode({
    pk        = { S = "STATION#${each.value.station}" }
    sk        = { S = "CONNECTOR#${split("#", each.key)[1]}" }
    status    = { S = "AVAILABLE" }
    powerKw   = { N = tostring(each.value.power) }
    plugType  = { S = each.value.plug }
    ultraFast = { BOOL = each.value.ultra }
  })
  # El estado del conector lo gestiona el servicio en runtime.
  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "wallet" {
  for_each   = var.seed_data ? local.wallets : {}
  table_name = aws_dynamodb_table.this["billing"].name
  hash_key   = "pk"
  range_key  = "sk"
  item = jsonencode({
    pk        = { S = "WALLET#${each.key}" }
    sk        = { S = "PROFILE" }
    fleetName = { S = each.value.name }
    balance   = { N = tostring(each.value.balance) }
    currency  = { S = "COP" }
  })
  lifecycle {
    ignore_changes = [item]
  }
}

output "table_names" {
  value = { for k, t in aws_dynamodb_table.this : k => t.name }
}

output "table_arns" {
  value = { for k, t in aws_dynamodb_table.this : k => t.arn }
}
