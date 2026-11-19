#!/usr/bin/env bash
# Uso: scripts/gql.sh '<query>' [url]
set -euo pipefail
URL="${2:-${GRAPHQL_URL:-http://localhost:4000/graphql}}"
jq -n --arg q "$1" '{query:$q}' | curl -s -H 'content-type: application/json' --data @- "$URL" | jq .
