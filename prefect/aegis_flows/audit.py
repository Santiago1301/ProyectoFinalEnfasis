"""Auditoría de consistencia de las SAGAs (lógica pura, sin AWS ni Prefect).

Cruza el log de SAGAs con las tablas de cada microservicio y comprueba que el
estado final de la SAGA coincida con lo que realmente quedó en cada servicio:

* COMPLETED: cobro vigente, reserva y sesión coherentes con la carga.
* COMPENSATED / FAILED / REJECTED: nada retenido (conector libre, dinero devuelto).
* Huérfanos: SAGAs atascadas o recursos activos cuya SAGA no existe.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Iterable, Mapping

Item = Mapping[str, Any]

TERMINAL = {"COMPLETED", "COMPENSATED", "FAILED", "COMPENSATION_FAILED", "REJECTED"}
ROLLED_BACK = {"COMPENSATED", "FAILED", "REJECTED"}
FIXTURE_PREFIX = "it-"  # datos que crean las pruebas de integración/E2E

CRITICAL = "critical"
INFO = "info"


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    detail: str
    saga_id: str | None = None


@dataclass
class Snapshot:
    """Lectura de las tablas de un ambiente."""

    sagas: list[Item] = field(default_factory=list)
    reservations: list[Item] = field(default_factory=list)
    connectors: list[Item] = field(default_factory=list)
    charges: list[Item] = field(default_factory=list)
    refunds: list[Item] = field(default_factory=list)
    sessions: list[Item] = field(default_factory=list)


@dataclass
class AuditReport:
    environment: str
    total_sagas: int
    audited_sagas: int
    skipped_recent: int
    by_status: dict[str, int]
    findings: list[Finding]

    @property
    def critical(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == CRITICAL]

    @property
    def compensated(self) -> list[Finding]:
        return [f for f in self.findings if f.code == "COMPENSATED"]

    @property
    def orphans(self) -> list[Finding]:
        return [f for f in self.findings if f.code.startswith(("ORPHAN_", "STUCK_"))]

    @property
    def compensation_rate(self) -> float:
        finished = sum(n for status, n in self.by_status.items() if status in TERMINAL)
        return round(self.by_status.get("COMPENSATED", 0) / finished, 4) if finished else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "environment": self.environment,
            "total_sagas": self.total_sagas,
            "audited_sagas": self.audited_sagas,
            "skipped_recent": self.skipped_recent,
            "by_status": self.by_status,
            "compensation_rate": self.compensation_rate,
            "findings": [asdict(f) for f in self.findings],
        }


def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _is_recent(item: Item, now: datetime, grace: timedelta) -> bool:
    """Las tablas no se leen de forma atómica: lo recién tocado puede estar en curso."""
    updated = parse_time(item.get("updatedAt") or item.get("createdAt"))
    return updated is not None and now - updated < grace


def _is_fixture(saga: Item) -> bool:
    return any(str(saga.get(key, "")).startswith(FIXTURE_PREFIX) for key in ("stationId", "fleetId"))


def _by_saga(items: Iterable[Item]) -> dict[str, Item]:
    return {str(i["sagaId"]): i for i in items if i.get("sagaId")}


def _connector_key(item: Item) -> tuple[str, str]:
    return str(item.get("stationId")), str(item.get("connectorId"))


def _was_stopped(saga: Item) -> bool:
    return any(s.get("name") == "STOP" and s.get("status") == "SUCCEEDED" for s in saga.get("steps", []))


def _check_completed(saga, reservation, connector, charge, refund, session) -> list[str]:
    problems: list[str] = []
    saga_id = str(saga["sagaId"])
    if charge is None:
        problems.append("sin cobro")
    else:
        if charge.get("status") != "SETTLED":
            problems.append(f"cobro en estado {charge.get('status')}")
        if saga.get("amount") is not None and Decimal(str(charge.get("amount"))) != Decimal(str(saga["amount"])):
            problems.append(f"monto {charge.get('amount')} distinto al de la SAGA {saga['amount']}")
    if refund is not None:
        problems.append("tiene reembolso pese a estar COMPLETED")
    if session is None:
        problems.append("sin sesión de carga")

    held = connector is not None and connector.get("reservationSagaId") == saga_id
    if _was_stopped(saga):
        if reservation is None or reservation.get("status") != "COMPLETED":
            problems.append("carga finalizada pero la reserva no está COMPLETED")
        if held:
            problems.append("carga finalizada pero el conector sigue retenido")
        if session is not None and session.get("status") == "ACTIVE":
            problems.append("carga finalizada pero la sesión sigue ACTIVE")
    else:
        if reservation is None or reservation.get("status") != "ACTIVE":
            problems.append("carga en curso sin reserva ACTIVE")
        if not held or connector.get("status") != "CHARGING":
            problems.append("carga en curso sin conector CHARGING retenido")
        if session is not None and session.get("status") not in {"ACTIVE", "COMPLETED"}:
            problems.append(f"carga en curso con sesión {session.get('status')}")
    return problems


def _check_rolled_back(saga, reservation, connector, charge, refund, session) -> list[str]:
    problems: list[str] = []
    if reservation is not None and reservation.get("status") != "RELEASED":
        problems.append(f"reserva sin liberar ({reservation.get('status')})")
    if connector is not None and connector.get("reservationSagaId") == str(saga["sagaId"]):
        problems.append("conector aún retenido")
    if charge is not None:
        if charge.get("status") != "REFUNDED":
            problems.append(f"cobro sin reembolsar ({charge.get('status')})")
        if refund is None:
            problems.append("cobro sin registro de reembolso")
        elif Decimal(str(refund.get("amount"))) != Decimal(str(charge.get("amount"))):
            problems.append(f"reembolso {refund.get('amount')} distinto al cobro {charge.get('amount')}")
    if session is not None and session.get("status") == "ACTIVE":
        problems.append("sesión de carga aún ACTIVE")
    return problems


def _orphans(snapshot: Snapshot, known: set[str], now: datetime, grace: timedelta) -> list[Finding]:
    found: list[Finding] = []

    def report(items: Iterable[Item], active: set[str], code: str, label: str) -> None:
        for item in items:
            saga_id = str(item.get("sagaId"))
            if item.get("status") in active and saga_id not in known and not _is_recent(item, now, grace):
                found.append(Finding(CRITICAL, code, f"{label} {item.get('status')} sin SAGA registrada", saga_id))

    fixture = lambda i: str(i.get("stationId", "")).startswith(FIXTURE_PREFIX) or str(i.get("fleetId", "")).startswith(FIXTURE_PREFIX)
    report([i for i in snapshot.reservations if not fixture(i)], {"RESERVED", "ACTIVE"}, "ORPHAN_RESERVATION", "Reserva")
    report([i for i in snapshot.charges if not fixture(i)], {"SETTLED"}, "ORPHAN_CHARGE", "Cobro")
    report([i for i in snapshot.sessions if not fixture(i)], {"ACTIVE"}, "ORPHAN_SESSION", "Sesión")

    for connector in snapshot.connectors:
        if fixture(connector) or connector.get("status") not in {"RESERVED", "CHARGING"} or _is_recent(connector, now, grace):
            continue
        saga_id = connector.get("reservationSagaId")
        if not saga_id or str(saga_id) not in known:
            place = f"{connector.get('stationId')}/{connector.get('connectorId')}"
            found.append(Finding(CRITICAL, "ORPHAN_CONNECTOR", f"Conector {place} {connector.get('status')} sin SAGA registrada", saga_id))
    return found


def audit_sagas(
    environment: str,
    snapshot: Snapshot,
    now: datetime | None = None,
    stuck_after: timedelta = timedelta(minutes=5),
    grace: timedelta = timedelta(seconds=60),
) -> AuditReport:
    now = now or datetime.now(timezone.utc)
    sagas = [s for s in snapshot.sagas if not _is_fixture(s)]
    reservations = _by_saga(snapshot.reservations)
    connectors = {_connector_key(c): c for c in snapshot.connectors}
    charges = _by_saga(snapshot.charges)
    refunds = _by_saga(snapshot.refunds)
    sessions = _by_saga(snapshot.sessions)

    findings: list[Finding] = []
    audited = skipped = 0
    for saga in sagas:
        saga_id = str(saga["sagaId"])
        status = saga.get("status")

        if status not in TERMINAL:
            updated = parse_time(saga.get("updatedAt"))
            if updated is None or now - updated >= stuck_after:
                findings.append(Finding(CRITICAL, "STUCK_SAGA", f"SAGA atascada en {status} desde {saga.get('updatedAt')}", saga_id))
                audited += 1
            else:
                skipped += 1
            continue
        if _is_recent(saga, now, grace):
            skipped += 1
            continue

        audited += 1
        parts = (
            reservations.get(saga_id),
            connectors.get(_connector_key(saga)),
            charges.get(saga_id),
            refunds.get(saga_id),
            sessions.get(saga_id),
        )
        if status == "COMPENSATION_FAILED":
            findings.append(Finding(CRITICAL, "COMPENSATION_FAILED", f"Requiere retrySagaCompensation: {saga.get('failureReason')}", saga_id))
            continue

        problems = _check_completed(saga, *parts) if status == "COMPLETED" else _check_rolled_back(saga, *parts)
        if problems:
            findings.append(Finding(CRITICAL, f"INCONSISTENT_{status}", "; ".join(problems), saga_id))
        elif status == "COMPENSATED":
            findings.append(Finding(INFO, "COMPENSATED", f"Compensada tras fallo en {saga.get('failedStep')}: {saga.get('failureReason')}", saga_id))

    findings.extend(_orphans(snapshot, {str(s["sagaId"]) for s in snapshot.sagas}, now, grace))
    return AuditReport(
        environment=environment,
        total_sagas=len(sagas),
        audited_sagas=audited,
        skipped_recent=skipped,
        by_status=dict(Counter(str(s.get("status")) for s in sagas)),
        findings=findings,
    )
