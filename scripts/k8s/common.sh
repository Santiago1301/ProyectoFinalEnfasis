#!/usr/bin/env bash
# Utilidades compartidas por los scripts de despliegue.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KUBE_CONTEXT="${KUBE_CONTEXT:-aegisvolt}"
IMAGE_REPO="${IMAGE_REPO:-aegisvolt}"   # en AWS: <cuenta>.dkr.ecr.<region>.amazonaws.com/aegisvolt
STABLE_REPLICAS="${STABLE_REPLICAS:-4}"
CANARY_REPLICAS="${CANARY_REPLICAS:-1}"  # 1 de 5 pods = 20% del tráfico
# En local (Floci) la AWS CLI usa el emulador; en AWS real LOCAL_EMULATOR=false.
if [[ "${LOCAL_EMULATOR:-true}" == true ]]; then
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
SERVICES=(station-reservation-service billing-wallet-service energy-dispatch-service graphql-gateway)

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

port_of() {
  case "$1" in
    graphql-gateway) echo 4000 ;;
    station-reservation-service) echo 4001 ;;
    billing-wallet-service) echo 4002 ;;
    energy-dispatch-service) echo 4003 ;;
    frontend) echo 8080 ;;
    *) echo "servicio desconocido: $1" >&2; return 1 ;;
  esac
}

# NodePort del gateway por ambiente (en local los 3 ambientes comparten clúster).
node_port_of() { # <env> [servicio]
  local base=30080
  [[ "${2:-}" == frontend ]] && base=30090
  case "$1" in dev) echo $base ;; test) echo $((base + 1)) ;; prod) echo $((base + 2)) ;; esac
}

# Ruta de lectura usada para generar tráfico de verificación.
probe_request_of() {
  case "$1" in
    graphql-gateway) echo "POST /graphql {\"query\":\"{ stations { stationId availableConnectors } featureFlags { name enabled } }\"}" ;;
    station-reservation-service) echo "GET /stations" ;;
    billing-wallet-service) echo "GET /wallets" ;;
    energy-dispatch-service) echo "GET /sessions" ;;
  esac
}

render_deployment() { # service track image version replicas namespace chaos
  sed -e "s|__SERVICE__|$1|g" -e "s|__TRACK__|$2|g" -e "s|__IMAGE__|$3|g" -e "s|__VERSION__|$4|g" \
      -e "s|__REPLICAS__|$5|g" -e "s|__NAMESPACE__|$6|g" -e "s|__CHAOS__|${7:-0}|g" \
      -e "s|__PORT__|$(port_of "$1")|g" "$ROOT/k8s/deployment.tpl.yaml"
}

render_service() { # service namespace env
  local type=ClusterIP line=""
  if [[ "$1" == graphql-gateway || "$1" == frontend ]]; then
    type=NodePort
    line="      nodePort: $(node_port_of "$3" "$1")"
  fi
  sed -e "s|__SERVICE__|$1|g" -e "s|__NAMESPACE__|$2|g" -e "s|__SERVICE_TYPE__|$type|g" \
      -e "s|__NODE_PORT_LINE__|$line|" "$ROOT/k8s/service.tpl.yaml"
}

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\033[1;31m[%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*" >&2; }
