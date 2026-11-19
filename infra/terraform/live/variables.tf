variable "region" {
  type    = string
  default = "us-east-1"
}

variable "use_local_emulator" {
  description = "true = Floci + minikube; false = AWS real + EKS"
  type        = bool
  default     = true
}

variable "emulator_endpoint" {
  description = "Endpoint de Floci visto desde Terraform"
  type        = string
  default     = "http://localhost:4566"
}

variable "emulator_endpoint_from_pods" {
  description = "Endpoint de Floci visto desde los pods de minikube"
  type        = string
  default     = "http://host.minikube.internal:4566"
}

variable "manage_kubernetes" {
  description = "Crear namespace/ConfigMap del ambiente en el clúster"
  type        = bool
  default     = true
}

variable "kube_config_path" {
  type    = string
  default = "~/.kube/config"
}

variable "kube_context" {
  type    = string
  default = "aegisvolt"
}

variable "local_backend_url" {
  description = "Destino del API Gateway emulado (gateway GraphQL expuesto en el host)"
  type        = string
  default     = "http://host.docker.internal:8080"
}
