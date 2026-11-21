###############################################################################
# AegisVolt - stack por ambiente.
#
# El ambiente NO es una variable: es el workspace de Terraform.
#   terraform workspace select dev|test|prod
# Todo nombre de recurso incluye ${terraform.workspace} y el estado de cada
# workspace vive en una llave distinta de S3 (env:/<ws>/...), por lo que un
# apply en `test` no puede tocar recursos ni estado de `prod`.
###############################################################################

locals {
  env  = terraform.workspace
  name = "aegisvolt-${terraform.workspace}"

  services = ["graphql-gateway", "station-reservation-service", "billing-wallet-service", "energy-dispatch-service"]

  # Configuración específica de cada ambiente estático.
  env_config = {
    dev = {
      vpc_cidr       = "10.10.0.0/16"
      log_retention  = 7
      node_types     = ["t3.medium"]
      node_count     = 1
      deletion_guard = false
      flag_mutations = true
      flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = true
        ENABLE_FAST_CHARGE_BOOST        = true
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
    test = {
      vpc_cidr       = "10.20.0.0/16"
      log_retention  = 14
      node_types     = ["t3.medium"]
      node_count     = 2
      deletion_guard = false
      flag_mutations = true
      flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = true
        ENABLE_FAST_CHARGE_BOOST        = true
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
    prod = {
      vpc_cidr       = "10.30.0.0/16"
      log_retention  = 30
      node_types     = ["t3.large"]
      node_count     = 3
      deletion_guard = true
      flag_mutations = false
      flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = false
        ENABLE_FAST_CHARGE_BOOST        = false
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
  }

  # El workspace_guard rechaza en plan cualquier workspace distinto de
  # dev/test/prod; el fallback a dev sólo permite `terraform validate`
  # (que siempre evalúa en el workspace "default").
  cfg = lookup(local.env_config, local.env, local.env_config.dev)

  flag_descriptions = {
    ENABLE_DYNAMIC_SURGE_PRICING    = "Tarifas dinámicas (x1.5 en horas pico, x1.2 fuera de pico)"
    ENABLE_FAST_CHARGE_BOOST        = "Reserva prioritaria de ultra-carga (+15%)"
    SIMULATE_CHARGER_HARDWARE_FAULT = "Inyección de fallo físico en el cargador (demo de rollback SAGA)"
  }
}

resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["dev", "test", "prod"], terraform.workspace)
      error_message = "Workspace inválido '${terraform.workspace}'. Use: terraform workspace select dev|test|prod"
    }
  }
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  environment        = local.env
  region             = var.region
  vpc_cidr           = local.cfg.vpc_cidr
  azs                = ["${var.region}a", "${var.region}b"]
  enable_nat_gateway = !var.use_local_emulator
}

module "dynamodb" {
  source              = "../modules/dynamodb"
  environment         = local.env
  deletion_protection = local.cfg.deletion_guard
  feature_flags = {
    for name, enabled in local.cfg.flags : name => { enabled = enabled, description = local.flag_descriptions[name] }
  }
}

module "observability" {
  source         = "../modules/observability"
  environment    = local.env
  services       = local.services
  retention_days = local.cfg.log_retention
}

module "api_gateway" {
  source                      = "../modules/api_gateway"
  name                        = local.name
  environment                 = local.env
  vpc_id                      = module.network.vpc_id
  vpc_cidr                    = module.network.vpc_cidr
  private_subnet_ids          = module.network.private_subnet_ids
  endpoints_security_group_id = module.network.endpoints_security_group_id
  private_integration         = !var.use_local_emulator
  local_backend_url           = var.local_backend_url
}

module "eks" {
  count                = var.use_local_emulator ? 0 : 1
  source               = "../modules/eks"
  name                 = local.name
  environment          = local.env
  private_subnet_ids   = module.network.private_subnet_ids
  node_instance_types  = local.cfg.node_types
  node_desired_size    = local.cfg.node_count
  dynamodb_table_arns  = values(module.dynamodb.table_arns)
  nlb_target_group_arn = module.api_gateway.nlb_target_group_arn
}

module "kubernetes_env" {
  count                = var.manage_kubernetes ? 1 : 0
  source               = "../modules/kubernetes_env"
  environment          = local.env
  table_names          = module.dynamodb.table_names
  aws_region           = var.region
  aws_endpoint_url     = var.use_local_emulator ? var.emulator_endpoint_from_pods : ""
  pods_role_arn        = var.use_local_emulator ? "" : module.eks[0].pods_role_arn
  allow_flag_mutations = local.cfg.flag_mutations
}
