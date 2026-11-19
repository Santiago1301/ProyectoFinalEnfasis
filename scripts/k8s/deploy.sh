#!/usr/bin/env bash
###############################################################################
# Despliega los 4 servicios en el namespace del ambiente.
#  - Primer despliegue (no existe stable): crea stable directamente.
#  - Siguientes: canary por servicio (scripts/k8s/canary.sh); si uno falla se
#    detiene el pipeline y los demás quedan en la versión anterior.
# Uso: scripts/k8s/deploy.sh <env> <tag> [servicio...]
###############################################################################
source "$(dirname "$0")/common.sh"
ENV="$1"; TAG="$2"; shift 2
NS="aegisvolt-$ENV"
TARGETS=("$@"); (( ${#TARGETS[@]} )) || TARGETS=("${SERVICES[@]}")

k get namespace "$NS" >/dev/null || { fail "No existe $NS: ejecute terraform apply en el workspace $ENV"; exit 1; }
k -n "$NS" apply -f "$ROOT/k8s/network-policy.yaml" >/dev/null

for svc in "${TARGETS[@]}"; do
  render_service "$svc" "$NS" "$ENV" | k apply -f - >/dev/null
  if k -n "$NS" get deploy "$svc-stable" >/dev/null 2>&1; then
    "$ROOT/scripts/k8s/canary.sh" "$ENV" "$svc" "$TAG"
  else
    log "Primer despliegue de $svc@$TAG en $ENV"
    render_deployment "$svc" stable "$IMAGE_REPO/$svc:$TAG" "$TAG" "$STABLE_REPLICAS" "$NS" 0 | k apply -f - >/dev/null
    k -n "$NS" rollout status "deploy/$svc-stable" --timeout=180s
  fi
done
log "Ambiente $ENV desplegado con $TAG"
