"""Lectura del estado real de cada ambiente: GraphQL, Kubernetes, DynamoDB y CloudWatch."""
from __future__ import annotations

import json
import os
import subprocess
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3
import httpx

from .audit import Snapshot

SERVICES = ["graphql-gateway", "station-reservation-service", "billing-wallet-service", "energy-dispatch-service"]
KUBE_CONTEXT = os.getenv("KUBE_CONTEXT", "aegisvolt")
HEALTH_QUERY = "{ environment { environment version flagMutationsAllowed services { name status } } }"

if os.getenv("AEGIS_TARGET", "local") == "local":
    os.environ.setdefault("AWS_ENDPOINT_URL", "http://localhost:4566")
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_DEFAULT_REGION", os.getenv("AWS_REGION", "us-east-1"))


def _kubectl(*args: str, timeout: int = 15) -> str:
    result = subprocess.run(
        ["kubectl", "--context", KUBE_CONTEXT, *args], capture_output=True, text=True, timeout=timeout, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"kubectl terminó con código {result.returncode}")
    return result.stdout


def query_gateway(environment: str) -> dict[str, Any]:
    """Consulta el gateway del ambiente.

    Con AEGIS_GRAPHQL_URL_<ENV> usa esa URL; si no, ejecuta la consulta dentro del
    pod, así no depende de port-forwards que se cortan en cada despliegue.
    """
    url = os.getenv(f"AEGIS_GRAPHQL_URL_{environment.upper()}")
    if url:
        started = time.perf_counter()
        response = httpx.post(url, json={"query": HEALTH_QUERY}, timeout=8)
        response.raise_for_status()
        return {"latency_ms": round((time.perf_counter() - started) * 1000), "body": response.json()}

    script = (
        "const t=Date.now();"
        "fetch('http://localhost:4000/graphql',{method:'POST',headers:{'content-type':'application/json'},"
        f"body:JSON.stringify({{query:{json.dumps(HEALTH_QUERY)}}})}})"
        ".then(r=>r.json()).then(b=>console.log(JSON.stringify({latency_ms:Date.now()-t,body:b})))"
        ".catch(e=>{console.error(e.message);process.exit(1)})"
    )
    output = _kubectl("-n", f"aegisvolt-{environment}", "exec", "deploy/graphql-gateway-stable", "--", "node", "-e", script)
    return json.loads(output.strip().splitlines()[-1])


def deployments(environment: str) -> list[dict[str, Any]]:
    data = json.loads(_kubectl("-n", f"aegisvolt-{environment}", "get", "deploy", "-o", "json"))
    return [
        {
            "name": d["metadata"]["name"],
            "version": d["metadata"].get("labels", {}).get("version", "?"),
            "desired": d["spec"].get("replicas", 0),
            "ready": d.get("status", {}).get("readyReplicas", 0),
        }
        for d in data["items"]
    ]


def _scan(table_name: str) -> list[dict[str, Any]]:
    table = boto3.resource("dynamodb").Table(table_name)
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"ConsistentRead": True}
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def load_snapshot(environment: str) -> Snapshot:
    """Sólo lectura. Las sagas se leen primero para no marcar como huérfano lo que nace después."""
    sagas = _scan(f"aegisvolt-sagas-{environment}")
    reservation_items = _scan(f"aegisvolt-reservations-{environment}")
    billing_items = _scan(f"aegisvolt-billing-{environment}")
    dispatch_items = _scan(f"aegisvolt-dispatch-{environment}")

    connectors = [
        {**i, "stationId": str(i["pk"]).removeprefix("STATION#"), "connectorId": str(i["sk"]).removeprefix("CONNECTOR#")}
        for i in reservation_items
        if str(i["pk"]).startswith("STATION#") and str(i["sk"]).startswith("CONNECTOR#")
    ]
    transactions = [i for i in billing_items if str(i["sk"]).startswith("TX#")]
    return Snapshot(
        sagas=sagas,
        reservations=[i for i in reservation_items if str(i["pk"]).startswith("RESERVATION#")],
        connectors=connectors,
        charges=[i for i in transactions if i.get("type") == "CHARGE"],
        refunds=[i for i in transactions if i.get("type") == "REFUND"],
        sessions=[i for i in dispatch_items if i.get("sk") == "SESSION"],
    )


def count_error_logs(environment: str, minutes: int) -> dict[str, int]:
    client = boto3.client("logs")
    start = int((datetime.now(timezone.utc) - timedelta(minutes=minutes)).timestamp() * 1000)
    counts: dict[str, int] = {}
    for service in SERVICES:
        total = 0
        kwargs: dict[str, Any] = {
            "logGroupName": f"/aegisvolt/{environment}/{service}",
            "startTime": start,
            "filterPattern": '{ $.level = "error" }',
        }
        while True:
            page = client.filter_log_events(**kwargs)
            total += len(page.get("events", []))
            if not page.get("nextToken"):
                break
            kwargs["nextToken"] = page["nextToken"]
        counts[service] = total
    return counts


def ship_to_cloudwatch(environment: str, records: list[dict[str, Any]]) -> None:
    """Deja el resultado en /aegisvolt/<env>/prefect, rastreable por correlation_id."""
    if not records:
        return
    client = boto3.client("logs")
    group = f"/aegisvolt/{environment}/prefect"
    stream = f"observability-{datetime.now(timezone.utc):%Y-%m-%d}"
    try:
        client.create_log_stream(logGroupName=group, logStreamName=stream)
    except client.exceptions.ResourceAlreadyExistsException:
        pass
    now = int(time.time() * 1000)
    client.put_log_events(
        logGroupName=group,
        logStreamName=stream,
        logEvents=[{"timestamp": now, "message": json.dumps(r, ensure_ascii=False, default=str)} for r in records],
    )
