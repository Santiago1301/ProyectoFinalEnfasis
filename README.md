# AegisVolt

Plataforma cloud-native de gestión de carga para flotas eléctricas y electrolineras.
Enunciado completo: [docs/](docs/).

## Arquitectura

```
Frontend (React)  ──HTTPS/WSS──►  API Gateway  ──VPC Link / VPCE──►  EKS (minikube en local)
                                                                      └─ graphql-gateway  (agregación GraphQL + orquestador SAGA)
                                                                          ├─ station-reservation-service → aegisvolt-reservations-<env>
                                                                          ├─ billing-wallet-service      → aegisvolt-billing-<env>
                                                                          └─ energy-dispatch-service     → aegisvolt-dispatch-<env>
```

| Pieza | Dónde |
|---|---|
| Microservicios (Node 22 + TypeScript + Express) | `services/*` |
| Esquema GraphQL | `services/graphql-gateway/src/schema.graphql` |
| SAGA por orquestación | `services/graphql-gateway/src/saga/orchestrator.ts` |
| Logger JSON + CloudWatch, feature flags, DynamoDB | `packages/shared` |
| Terraform (bootstrap S3 + stack por workspace) | `infra/terraform` |

## SAGA "Reservar y Activar Carga"

1. **RESERVE**: conector `AVAILABLE → RESERVED` (transacción local + registro `RESERVATION#<saga>`).
2. **CHARGE**: descuenta el saldo y crea `TX#<saga>#CHARGE` (condición `attribute_not_exists` = idempotente).
3. **DISPATCH**: activa el cargador; falla si `SIMULATE_CHARGER_HARDWARE_FAULT=true`.

Si un paso falla, se compensan **en orden inverso** todos los pasos intentados:
`stop sesión → refund (TX#<saga>#REFUND) → release (AVAILABLE)`. Cada compensación es idempotente
(llaves condicionales por `sagaId`) y es un no-op si la acción original nunca ocurrió, por eso un
mensaje duplicado o un reintento no reembolsa dos veces. El estado de cada SAGA se persiste en
`aegisvolt-sagas-<env>` con bloqueo optimista (`version`).

## Ambiente local (Floci + minikube)

Requisitos: Docker, Terraform ≥ 1.10, Node 22, minikube, AWS CLI.

```bash
npm install
make cloud-up        # Floci en :4566
make cluster-up      # minikube, contexto "aegisvolt"
make bootstrap       # bucket S3 versionado para el tfstate
make tf-init
make tf-apply ENV=dev    # repetir con ENV=test y ENV=prod
make dev ENV=dev         # servicios en local → http://localhost:4000/graphql
```

### Demostración de rollback

```bash
scripts/gql.sh 'mutation { setFeatureFlag(name:"SIMULATE_CHARGER_HARDWARE_FAULT", enabled:true) { enabled } }'
scripts/gql.sh 'mutation { reserveAndCharge(input:{fleetId:"fleet-rappi", stationId:"bog-zf", connectorId:"c1", energyKwh:10}) { sagaId status steps { name status } } }'
```

La flota `fleet-startup` tiene saldo bajo para demostrar la compensación del paso 2.

### Versiones del tfstate en S3

```bash
AWS_ENDPOINT_URL=http://localhost:4566 aws s3api list-object-versions \
  --bucket aegisvolt-tfstate --prefix env:/dev/
```

Para restaurar: `aws s3api copy-object --copy-source "aegisvolt-tfstate/env:/dev/aegisvolt/terraform.tfstate?versionId=<id>" --bucket aegisvolt-tfstate --key env:/dev/aegisvolt/terraform.tfstate`.

## Kubernetes y Canary Deployment

Cada ambiente es un namespace (`aegisvolt-dev|test|prod`) creado por Terraform con su
`ConfigMap` (tablas, endpoint, flags de gobernanza). Cada servicio tiene dos Deployments
que comparten la etiqueta `app`: `<svc>-stable` (4 réplicas) y, durante un despliegue,
`<svc>-canary` (1 réplica). El `Service` selecciona sólo `app`, así que **1 de 5 pods = 20%
del tráfico** va a la versión nueva.

```bash
NODE_IMAGE=node:20-slim scripts/k8s/build-images.sh v1.0.0 --minikube   # construye y carga en minikube
scripts/k8s/deploy.sh dev v1.0.0                                         # primer despliegue: directo a stable
scripts/k8s/build-images.sh v1.1.0 --minikube && scripts/k8s/deploy.sh dev v1.1.0   # canary por servicio
scripts/k8s/canary.sh dev graphql-gateway v1.2.0 0.5                     # canary con 50% de errores → rollback
```

`scripts/k8s/canary.sh` promueve al 100% sólo si se cumplen **todas** las condiciones:

| Condición | Fuente | Umbral |
|---|---|---|
| Pods canary Ready y sin reinicios | Kubernetes | 0 reinicios |
| Tráfico atendido por el canary | `/metrics` del pod canary | ≥ 10 requests |
| Tasa de errores 5xx del canary | `/metrics` del pod canary | ≤ 5% |
| Logs `level=error` con `track=canary` y `version=<tag>` | CloudWatch `/aegisvolt/<env>/<svc>` | < 5 |

Si alguna falla, borra el Deployment canary (rollback automático): el stable nunca se modificó.
Si pasa, actualiza stable con rolling update `maxUnavailable: 0` (sin caída) y elimina el canary.

## Frontend (React + Vite)

Consola en `frontend/` con los 4 paneles de la rúbrica: electrolineras en tiempo real
(suscripción GraphQL por **WSS**, con respaldo por polling), flujo de reserva que dispara la
SAGA y muestra su línea de tiempo y telemetría, feature flags del ambiente y historial de
SAGAs con sus compensaciones. El color de la franja y el badge salen del ambiente que reporta
el gateway (verde dev, ámbar test, rojo prod).

En Kubernetes corre como nginx sin privilegios: sirve los estáticos y reenvía `/graphql`
(HTTP y WebSocket) al `graphql-gateway` de su mismo namespace, así cada ambiente habla sólo
con su API. En prod la UI muestra las flags en sólo lectura (`ALLOW_FLAG_MUTATIONS=false`).

```bash
kubectl --context aegisvolt -n aegisvolt-dev  port-forward svc/frontend 3000:80   # http://localhost:3000
kubectl --context aegisvolt -n aegisvolt-prod port-forward svc/frontend 3002:80   # http://localhost:3002
# desarrollo con recarga en caliente contra el gateway de dev:
kubectl --context aegisvolt -n aegisvolt-dev port-forward svc/graphql-gateway 8080:80
GATEWAY_URL=http://localhost:8080 npm run dev -w frontend
```

Demostración "cambiar una flag en dev sin redesplegar":

```bash
AWS_ENDPOINT_URL=http://localhost:4566 aws dynamodb update-item --table-name aegisvolt-feature-flags-dev \
  --key '{"name":{"S":"ENABLE_FAST_CHARGE_BOOST"}}' --update-expression 'SET enabled = :f' \
  --expression-attribute-values '{":f":{"BOOL":false}}'
```

## Estado del proyecto

- [x] Microservicios, gateway GraphQL, SAGA con compensaciones e idempotencia, feature flags por ambiente
- [x] Terraform: bootstrap S3 versionado, workspaces dev/test/prod, VPC/VPCE, DynamoDB, CloudWatch, API Gateway, EKS (AWS real), namespace k8s
- [x] Dockerfile + manifiestos Kubernetes + canary con análisis y rollback automático
- [x] Frontend React (tiempo real por WSS, SAGA, flags por ambiente, historial de compensaciones)
- [ ] GitHub Actions + protección de ramas
- [ ] Flujos de Prefect
