from datetime import datetime, timedelta, timezone
from decimal import Decimal

from aegis_flows.audit import Snapshot, audit_sagas

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
OLD = (NOW - timedelta(hours=1)).isoformat()


def saga(status="COMPLETED", saga_id="s1", **extra):
    return {"sagaId": saga_id, "status": status, "stationId": "st", "connectorId": "c1", "fleetId": "f",
            "amount": Decimal("100"), "steps": [], "updatedAt": OLD, **extra}


def reservation(status="ACTIVE"):
    return {"sagaId": "s1", "status": status, "stationId": "st", "connectorId": "c1", "updatedAt": OLD}


def connector(status="CHARGING", holder="s1"):
    item = {"stationId": "st", "connectorId": "c1", "status": status, "updatedAt": OLD}
    return {**item, "reservationSagaId": holder} if holder else item


def tx(status="SETTLED", amount="100"):
    return {"sagaId": "s1", "status": status, "amount": Decimal(amount), "updatedAt": OLD}


def session(status="ACTIVE"):
    return {"sagaId": "s1", "status": status, "updatedAt": OLD}


def codes(snapshot):
    return [f.code for f in audit_sagas("dev", snapshot, now=NOW).findings]


def test_completada_coherente_no_genera_hallazgos():
    assert codes(Snapshot([saga()], [reservation()], [connector()], [tx()], [], [session()])) == []


def test_finalizada_coherente_no_genera_hallazgos():
    stopped = saga(steps=[{"name": "STOP", "status": "SUCCEEDED"}])
    snap = Snapshot([stopped], [reservation("COMPLETED")], [connector("AVAILABLE", None)], [tx()], [], [session("STOPPED")])
    assert codes(snap) == []


def test_completada_sin_cobro_es_inconsistente():
    assert codes(Snapshot([saga()], [reservation()], [connector()], [], [], [session()])) == ["INCONSISTENT_COMPLETED"]


def test_compensada_correcta_se_reporta_como_informativa():
    snap = Snapshot([saga("COMPENSATED", failedStep="DISPATCH")], [reservation("RELEASED")],
                    [connector("AVAILABLE", None)], [tx("REFUNDED")], [tx()], [])
    report = audit_sagas("dev", snap, now=NOW)
    assert [f.code for f in report.compensated] == ["COMPENSATED"]
    assert report.critical == []


def test_compensada_sin_reembolso_es_inconsistente():
    snap = Snapshot([saga("COMPENSATED")], [reservation("RELEASED")], [connector("AVAILABLE", None)], [tx()], [], [])
    assert codes(snap) == ["INCONSISTENT_COMPENSATED"]


def test_reembolso_parcial_es_inconsistente():
    snap = Snapshot([saga("COMPENSATED")], [reservation("RELEASED")], [connector("AVAILABLE", None)],
                    [tx("REFUNDED")], [tx(amount="50")], [])
    assert codes(snap) == ["INCONSISTENT_COMPENSATED"]


def test_compensada_con_conector_retenido_es_inconsistente():
    snap = Snapshot([saga("COMPENSATED")], [reservation("RELEASED")], [connector("RESERVED")], [], [], [])
    assert codes(snap) == ["INCONSISTENT_COMPENSATED"]


def test_saga_atascada_es_huerfana():
    report = audit_sagas("dev", Snapshot([saga("PAID")]), now=NOW)
    assert [f.code for f in report.orphans] == ["STUCK_SAGA"]


def test_saga_en_curso_reciente_no_es_huerfana():
    recent = saga("PAID", updatedAt=(NOW - timedelta(seconds=30)).isoformat())
    report = audit_sagas("dev", Snapshot([recent]), now=NOW)
    assert report.findings == [] and report.skipped_recent == 1


def test_compensacion_fallida_es_critica():
    assert codes(Snapshot([saga("COMPENSATION_FAILED")])) == ["COMPENSATION_FAILED"]


def test_recursos_sin_saga_son_huerfanos():
    snap = Snapshot([], [reservation()], [connector()], [tx()], [], [session()])
    assert sorted(codes(snap)) == ["ORPHAN_CHARGE", "ORPHAN_CONNECTOR", "ORPHAN_RESERVATION", "ORPHAN_SESSION"]


def test_recursos_ya_cerrados_sin_saga_no_son_huerfanos():
    snap = Snapshot([], [reservation("RELEASED")], [connector("AVAILABLE", None)], [tx("REFUNDED")], [], [session("STOPPED")])
    assert codes(snap) == []


def test_datos_de_pruebas_se_ignoran():
    assert audit_sagas("dev", Snapshot([saga("PAID", stationId="it-abc")]), now=NOW).total_sagas == 0
