#!/usr/bin/env bash
###############################################################################
# Canary deployment de UN servicio:
#   1. Despliega <servicio>-canary (1 réplica) junto a <servicio>-stable (4).
#      El Service balancea por réplicas => ~20% del tráfico va al canary.
#   2. Genera tráfico real a través del Service desde dentro del clúster.
#   3. Análisis (todas deben cumplirse para promover):
#        a. pods canary Ready y sin reinicios
#        b. >= MIN_REQUESTS atendidas por el canary
#        c. tasa de 5xx del canary (/metrics) <= MAX_ERROR_RATE
#        d. logs de error del canary en CloudWatch
#           (/aegisvolt/<env>/<servicio>, track=canary, version=<tag>) < MAX_CW_ERRORS
#   4. OK  -> rolling update de stable a la nueva versión (100%) y borra canary.
#      MAL -> borra el canary (rollback automático); stable nunca se tocó.
#
# Uso: scripts/k8s/canary.sh <env> <servicio> <tag> [chaos_error_rate]
###############################################################################
source "$(dirname "$0")/common.sh"

ENV="$1"; SERVICE="$2"; TAG="$3"; CHAOS="${4:-0}"
NS="aegisvolt-$ENV"
IMAGE="$IMAGE_REPO/$SERVICE:$TAG"
PORT="$(port_of "$SERVICE")"
MIN_REQUESTS="${MIN_REQUESTS:-10}"
MAX_ERROR_RATE="${MAX_ERROR_RATE:-0.05}"
MAX_CW_ERRORS="${MAX_CW_ERRORS:-5}"
LOAD_REQUESTS="${LOAD_REQUESTS:-150}"

rollback() {
  fail "ROLLBACK $SERVICE@$TAG en $ENV: $1"
  k -n "$NS" delete deployment "$SERVICE-canary" --ignore-not-found --wait=true >/dev/null
  k -n "$NS" delete pod canary-loadgen --ignore-not-found >/dev/null 2>&1 || true
  echo "result=rolled_back" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 1
}

STABLE_VERSION="$(k -n "$NS" get deploy "$SERVICE-stable" -o jsonpath='{.metadata.labels.version}' 2>/dev/null || true)"
if [[ "$STABLE_VERSION" == "$TAG" && "$CHAOS" == "0" ]]; then
  log "$SERVICE ya corre $TAG en stable; nada que hacer"; exit 0
fi

log "Canary $SERVICE: stable=$STABLE_VERSION -> canary=$TAG (${CANARY_REPLICAS}/$((STABLE_REPLICAS + CANARY_REPLICAS)) pods) chaos=$CHAOS"
START_MS=$(( $(date +%s) * 1000 ))
render_deployment "$SERVICE" canary "$IMAGE" "$TAG" "$CANARY_REPLICAS" "$NS" "$CHAOS" | k apply -f - >/dev/null
k -n "$NS" rollout status "deploy/$SERVICE-canary" --timeout=120s || rollback "el canary no quedó Ready"

# --- Tráfico de verificación a través del Service (incluye stable y canary) ---
# El generador corre DENTRO del clúster (pod efímero con la misma imagen) para
# pasar por kube-proxy y repartirse entre stable y canary.
read -r METHOD PATH_ BODY <<<"$(probe_request_of "$SERVICE")"
log "Generando $LOAD_REQUESTS peticiones $METHOD $PATH_ vía Service $SERVICE"
k -n "$NS" delete pod canary-loadgen --ignore-not-found >/dev/null 2>&1 || true
# agent:false => una conexión TCP nueva por petición: kube-proxy balancea por
# conexión, así el reparto real refleja la proporción de réplicas (~20%).
LOADGEN_JS="const http=require('http');const n=$LOAD_REQUESTS,c={};const one=()=>new Promise(ok=>{const b=process.env.BODY||'';const r=http.request({host:'$SERVICE',path:'$PATH_',method:'$METHOD',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(b)}},res=>{res.resume();res.on('end',()=>{c[res.statusCode]=(c[res.statusCode]||0)+1;ok()})});r.on('error',()=>{c.ERR=(c.ERR||0)+1;ok()});r.end(b)});(async()=>{for(let i=0;i<n;i++)await one();console.log(JSON.stringify(c))})()"
k -n "$NS" run canary-loadgen --image="$IMAGE" --image-pull-policy=IfNotPresent --restart=Never \
  --labels=app=canary-loadgen --env="BODY=${BODY:-}" --command -- node -e "$LOADGEN_JS" >/dev/null
k -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/canary-loadgen --timeout=180s >/dev/null || rollback "el generador de carga no terminó"
log "Códigos HTTP observados (stable+canary): $(k -n "$NS" logs canary-loadgen)"
k -n "$NS" delete pod canary-loadgen --ignore-not-found >/dev/null

# --- Análisis ---
PODS=$(k -n "$NS" get pods -l "app=$SERVICE,track=canary" -o jsonpath='{.items[*].metadata.name}')
TOTAL=0; ERRORS=0; RESTARTS=0
for pod in $PODS; do
  m=$(k -n "$NS" exec "$pod" -- node -e "fetch('http://127.0.0.1:$PORT/metrics').then(r=>r.text()).then(console.log)")
  TOTAL=$(( TOTAL + $(jq -r .requests_total <<<"$m") ))
  ERRORS=$(( ERRORS + $(jq -r .errors_5xx_total <<<"$m") ))
  RESTARTS=$(( RESTARTS + $(k -n "$NS" get pod "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}') ))
done
RATE=$(awk -v e="$ERRORS" -v t="$TOTAL" 'BEGIN { printf "%.4f", (t ? e / t : 0) }')

sleep 3 # deja que el logger envíe el último lote a CloudWatch
CW_ERRORS=$(aws logs filter-log-events \
  --log-group-name "/aegisvolt/$ENV/$SERVICE" --start-time "$START_MS" \
  --filter-pattern "{ \$.track = \"canary\" && \$.version = \"$TAG\" && \$.level = \"error\" }" \
  --query 'length(events)' --output text 2>/dev/null || echo 0)

log "Análisis canary: requests=$TOTAL errores5xx=$ERRORS tasa=$RATE (máx $MAX_ERROR_RATE) reinicios=$RESTARTS errores CloudWatch=$CW_ERRORS (máx $((MAX_CW_ERRORS - 1)))"
{
  echo "### Canary $SERVICE@$TAG ($ENV)"
  echo "| métrica | valor | umbral |"; echo "|---|---|---|"
  echo "| requests canary | $TOTAL | >= $MIN_REQUESTS |"
  echo "| tasa 5xx | $RATE | <= $MAX_ERROR_RATE |"
  echo "| reinicios | $RESTARTS | 0 |"
  echo "| errores CloudWatch | $CW_ERRORS | < $MAX_CW_ERRORS |"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

(( RESTARTS == 0 )) || rollback "el canary se reinició $RESTARTS veces"
(( TOTAL >= MIN_REQUESTS )) || rollback "tráfico insuficiente al canary ($TOTAL < $MIN_REQUESTS)"
awk -v r="$RATE" -v m="$MAX_ERROR_RATE" 'BEGIN { exit !(r <= m) }' || rollback "tasa de error $RATE > $MAX_ERROR_RATE"
(( CW_ERRORS < MAX_CW_ERRORS )) || rollback "$CW_ERRORS errores del canary en CloudWatch"

# --- Promoción al 100% ---
log "Umbrales cumplidos: promoviendo $SERVICE@$TAG a stable (rolling update, maxUnavailable=0)"
render_deployment "$SERVICE" stable "$IMAGE" "$TAG" "$STABLE_REPLICAS" "$NS" 0 | k apply -f - >/dev/null
k -n "$NS" rollout status "deploy/$SERVICE-stable" --timeout=180s || rollback "falló el rolling update de stable"
k -n "$NS" delete deployment "$SERVICE-canary" --wait=true >/dev/null
echo "result=promoted" >> "${GITHUB_OUTPUT:-/dev/null}"
log "PROMOVIDO $SERVICE@$TAG en $ENV"
