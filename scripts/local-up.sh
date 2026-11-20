#!/usr/bin/env bash
###############################################################################
# Levanta el entorno local después de reiniciar el equipo o Docker Desktop:
#   1. Floci (persistente en el volumen floci-data)
#   2. Nodo de minikube. Si `minikube start` se cuelga descargando la imagen
#      base (problema conocido de pulls en este Docker Desktop), arranca el
#      contenedor directamente y repara lo que minikube start haría:
#      /etc/hosts del nodo, kubelet, kubeconfig, kube-proxy y CoreDNS.
###############################################################################
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=aegisvolt
log() { printf '\033[1;34m[local-up]\033[0m %s\n' "$*"; }

log "Floci"
docker compose up -d floci >/dev/null
until curl -sf localhost:4566/_floci/health >/dev/null; do sleep 1; done

log "Nodo de minikube"
docker start "$PROFILE" >/dev/null
NODE_IP="$(docker inspect "$PROFILE" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
docker exec "$PROFILE" sh -c "grep -q control-plane.minikube.internal /etc/hosts || echo '$NODE_IP	control-plane.minikube.internal' >> /etc/hosts"
docker exec "$PROFILE" systemctl start kubelet
minikube -p "$PROFILE" update-context >/dev/null
until kubectl --context "$PROFILE" get nodes --request-timeout=3s >/dev/null 2>&1; do sleep 3; done

log "Reiniciando kube-proxy y CoreDNS"
kubectl --context "$PROFILE" -n kube-system delete pod -l k8s-app=kube-proxy --wait=false >/dev/null
kubectl --context "$PROFILE" -n kube-system delete pod -l k8s-app=kube-dns --wait=false >/dev/null
kubectl --context "$PROFILE" -n kube-system rollout status deploy/coredns --timeout=180s >/dev/null

log "Listo. Pods de AegisVolt:"
kubectl --context "$PROFILE" get pods -A -l app.kubernetes.io/part-of=aegisvolt --no-headers | awk '{print "  " $1 "/" $2 " " $4}'
