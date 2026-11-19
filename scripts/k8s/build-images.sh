#!/usr/bin/env bash
# Construye las 4 imágenes. Con --minikube además las carga en el clúster
# local (sin registry). En CI se publican en ECR.
# Uso: scripts/k8s/build-images.sh <tag> [--minikube]
source "$(dirname "$0")/common.sh"
TAG="$1"
for svc in "${SERVICES[@]}"; do
  log "docker build $IMAGE_REPO/$svc:$TAG"
  docker build -q --pull=false --build-arg NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}" --build-arg SERVICE="$svc" --build-arg APP_VERSION="$TAG" -t "$IMAGE_REPO/$svc:$TAG" "$ROOT" >/dev/null
done
if [[ "${2:-}" == --minikube ]]; then
  for svc in "${SERVICES[@]}"; do
    log "minikube image load $IMAGE_REPO/$svc:$TAG"
    minikube -p aegisvolt image load "$IMAGE_REPO/$svc:$TAG"
  done
fi
log "Imágenes $TAG listas"
