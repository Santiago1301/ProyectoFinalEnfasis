#!/usr/bin/env bash
# Corre los 4 servicios con tsx contra Floci, usando las tablas del ambiente dado.
set -euo pipefail
ENV="${1:-dev}"
cd "$(dirname "$0")/.."
export AEGIS_ENV="$ENV" AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test CLOUDWATCH_LOGS_ENABLED=true FLAG_CACHE_TTL_MS=1000
pids=()
for svc in station-reservation-service billing-wallet-service energy-dispatch-service graphql-gateway; do
  (cd "services/$svc" && npx tsx src/index.ts) & pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null' INT TERM EXIT
echo "GraphQL en http://localhost:4000/graphql (ambiente $ENV)"
wait
