"""Flujos de Prefect: salud de los 3 ambientes, auditoría SAGA y métricas.

    python -m aegis_flows.observability          # una ejecución
    python -m aegis_flows.observability --serve  # programado cada 5 minutos

Los flujos sólo leen el estado de la plataforma. Escriben únicamente sus
artefactos en Prefect y sus resultados en /aegisvolt/<env>/prefect.
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from typing import Any

from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact
from prefect.states import Failed

from . import sources
from .audit import CRITICAL, AuditReport, audit_sagas

ENVIRONMENTS = ["dev", "test", "prod"]
ERROR_WINDOW_MINUTES = int(os.getenv("OBS_ERROR_WINDOW_MINUTES", "15"))
INTERVAL_SECONDS = int(os.getenv("OBS_INTERVAL_SECONDS", "300"))


@task(name="salud-gateway", task_run_name="salud-gateway-{environment}")
def check_gateway(environment: str) -> dict[str, Any]:
    try:
        result = sources.query_gateway(environment)
        info = result["body"]["data"]["environment"]
    except Exception as exc:  # un ambiente caído es un resultado, no un fallo del monitor
        get_run_logger().error("Gateway de %s no responde: %s", environment, exc)
        return {"status": "DOWN", "error": str(exc), "services": {}, "version": "?", "latency_ms": None}

    services = {s["name"]: s["status"] for s in info["services"]}
    problems = [f"{name}={status}" for name, status in services.items() if status != "UP"]
    if info["environment"] != environment:
        problems.append(f"responde como {info['environment']}")
    if environment == "prod" and info["flagMutationsAllowed"]:
        problems.append("prod permite cambiar flags por API")
    return {
        "status": "DEGRADED" if problems else "HEALTHY",
        "problems": problems,
        "services": services,
        "version": info["version"],
        "latency_ms": result["latency_ms"],
    }


@task(name="salud-kubernetes", task_run_name="salud-kubernetes-{environment}")
def check_kubernetes(environment: str) -> dict[str, Any]:
    try:
        items = sources.deployments(environment)
    except Exception as exc:
        get_run_logger().error("No se pudo leer Kubernetes de %s: %s", environment, exc)
        return {"status": "DOWN", "error": str(exc), "deployments": []}
    not_ready = [d["name"] for d in items if d["ready"] < d["desired"]]
    return {"status": "DEGRADED" if not_ready or not items else "HEALTHY", "not_ready": not_ready, "deployments": items}


@task(name="auditar-sagas", task_run_name="auditar-sagas-{environment}", retries=2, retry_delay_seconds=3)
def audit_environment(environment: str) -> AuditReport:
    report = audit_sagas(environment, sources.load_snapshot(environment))
    logger = get_run_logger()
    for finding in report.critical:
        logger.error("[%s] %s correlation_id=%s: %s", environment, finding.code, finding.saga_id, finding.detail)
    return report


@task(name="errores-cloudwatch", task_run_name="errores-cloudwatch-{environment}", retries=2, retry_delay_seconds=3)
def collect_errors(environment: str) -> dict[str, int]:
    return sources.count_error_logs(environment, ERROR_WINDOW_MINUTES)


def overall_status(gateway: dict[str, Any], kubernetes: dict[str, Any], audit: AuditReport) -> str:
    if gateway["status"] == "DOWN" or kubernetes["status"] == "DOWN":
        return "DOWN"
    if gateway["status"] != "HEALTHY" or kubernetes["status"] != "HEALTHY":
        return "DEGRADED"
    return "INCONSISTENT" if audit.critical else "HEALTHY"


def _markdown(environment, status, gateway, kubernetes, audit: AuditReport, errors) -> str:
    lines = [
        f"# AegisVolt `{environment}`: {status}",
        "",
        f"Versión `{gateway['version']}` · latencia {gateway['latency_ms']} ms · "
        f"errores en CloudWatch ({ERROR_WINDOW_MINUTES} min): {sum(errors.values())}",
        "",
        "## SAGAs",
        f"Total {audit.total_sagas} · auditadas {audit.audited_sagas} · huérfanas {len(audit.orphans)} · "
        f"compensadas {len(audit.compensated)} · tasa de compensación {audit.compensation_rate:.1%}",
        "",
    ]
    if audit.findings:
        lines += ["| Severidad | Hallazgo | correlation_id | Detalle |", "|---|---|---|---|"]
        for f in sorted(audit.findings, key=lambda x: x.severity != CRITICAL):
            detail = f.detail.replace("|", "/").replace("\n", " ")
            lines.append(f"| {f.severity} | {f.code} | `{f.saga_id or '-'}` | {detail} |")
    else:
        lines.append("Sin hallazgos.")
    lines += ["", "## Despliegues", "| Deployment | Versión | Listas |", "|---|---|---|"]
    lines += [f"| {d['name']} | `{d['version']}` | {d['ready']}/{d['desired']} |" for d in kubernetes["deployments"]]
    return "\n".join(lines)


@task(name="publicar-reporte", task_run_name="publicar-reporte-{environment}")
def publish_report(environment: str, status: str, gateway, kubernetes, audit: AuditReport, errors) -> dict[str, Any]:
    summary = {
        "ambiente": environment,
        "estado": status,
        "version": gateway["version"],
        "latencia_ms": gateway["latency_ms"],
        "pods_listos": f"{sum(d['ready'] for d in kubernetes['deployments'])}/{sum(d['desired'] for d in kubernetes['deployments'])}",
        "sagas": audit.total_sagas,
        "completadas": audit.by_status.get("COMPLETED", 0),
        "compensadas": audit.by_status.get("COMPENSATED", 0),
        "huerfanas": len(audit.orphans),
        "inconsistencias": len(audit.critical),
        f"errores_{ERROR_WINDOW_MINUTES}min": sum(errors.values()),
    }
    create_markdown_artifact(
        key=f"aegisvolt-{environment}",
        markdown=_markdown(environment, status, gateway, kubernetes, audit, errors),
        description=f"Salud y auditoría SAGA de {environment}",
    )
    at = datetime.now(timezone.utc).isoformat()
    base = {"timestamp": at, "level": "info", "service": "prefect", "environment": environment}
    records: list[dict[str, Any]] = [{**base, "message": "observability_summary", **summary}]
    for f in audit.findings:
        records.append(
            {
                **base,
                "level": "error" if f.severity == CRITICAL else "info",
                "message": "saga_audit_finding",
                "correlation_id": f.saga_id,
                "code": f.code,
                "detail": f.detail,
            }
        )
    try:
        sources.ship_to_cloudwatch(environment, records)
    except Exception as exc:
        get_run_logger().warning("No se pudo escribir en CloudWatch (%s): %s", environment, exc)
    return summary


@flow(name="observabilidad-ambiente", flow_run_name="observabilidad-{environment}")
def environment_observability(environment: str) -> dict[str, Any]:
    gateway = check_gateway(environment)
    kubernetes = check_kubernetes(environment)
    audit = audit_environment(environment)
    errors = collect_errors(environment)
    status = overall_status(gateway, kubernetes, audit)
    return publish_report(environment, status, gateway, kubernetes, audit, errors)


@flow(name="observabilidad-aegisvolt", log_prints=True)
def platform_observability(environments: list[str] | None = None):
    summaries = [environment_observability(env) for env in (environments or ENVIRONMENTS)]
    create_table_artifact(
        key="aegisvolt-overview",
        table=summaries,
        description="Estado de los ambientes de AegisVolt",
    )
    for s in summaries:
        print(
            f"{s['ambiente']:<5} {s['estado']:<13} {s['version']:<12} pods {s['pods_listos']:<6} "
            f"sagas {s['sagas']} (compensadas {s['compensadas']}, huérfanas {s['huerfanas']}, "
            f"inconsistencias {s['inconsistencias']})"
        )
    unhealthy = [f"{s['ambiente']}={s['estado']}" for s in summaries if s["estado"] != "HEALTHY"]
    if unhealthy:
        return Failed(message="Ambientes con problemas: " + ", ".join(unhealthy))
    return summaries


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help=f"programa el flujo cada {INTERVAL_SECONDS} s")
    if parser.parse_args().serve:
        platform_observability.serve(name="cada-5-minutos", interval=INTERVAL_SECONDS, tags=["aegisvolt", "observabilidad"])
    else:
        state = platform_observability(return_state=True)
        raise SystemExit(1 if state.is_failed() else 0)
