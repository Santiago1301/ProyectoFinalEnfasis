import { useEffect, useState } from 'react';
import { fmtMoney, gql, useQuery } from '../api';
import { M_RESERVE, M_STOP, Q_QUOTE, Q_SAGA } from '../queries';
import type { FeatureFlag, Quote, Saga, Station, Wallet } from '../types';
import { SagaTimeline } from './SagaTimeline';

interface Props {
  stations?: Station[];
  wallets?: Wallet[];
  flags?: FeatureFlag[];
  selected?: { stationId: string; connectorId: string };
  onSelect: (stationId: string, connectorId: string) => void;
  onDone: () => void;
}

export function ReservePanel({ stations, wallets, flags, selected, onSelect, onDone }: Props) {
  const [fleetId, setFleetId] = useState('fleet-rappi');
  const [energy, setEnergy] = useState(20);
  const [boost, setBoost] = useState(false);
  const [quote, setQuote] = useState<Quote>();
  const [quoteErr, setQuoteErr] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [sagaId, setSagaId] = useState<string>();

  const boostEnabled = flags?.find((f) => f.name === 'ENABLE_FAST_CHARGE_BOOST')?.enabled ?? false;
  const faultFlag = flags?.find((f) => f.name === 'SIMULATE_CHARGER_HARDWARE_FAULT')?.enabled ?? false;
  const station = stations?.find((s) => s.stationId === selected?.stationId);
  const connector = station?.connectors.find((c) => c.connectorId === selected?.connectorId);
  const canBoost = boostEnabled && !!connector?.ultraFast;

  useEffect(() => {
    if (!canBoost) setBoost(false);
  }, [canBoost]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    gql<{ quote: Quote }>(Q_QUOTE, { input: { ...selected, energyKwh: energy, fastChargeBoost: boost } })
      .then((d) => alive && (setQuote(d.quote), setQuoteErr(undefined)))
      .catch((e) => alive && setQuoteErr(e.message));
    return () => {
      alive = false;
    };
  }, [selected?.stationId, selected?.connectorId, energy, boost, flags]);

  const { data: sagaData, refetch: refetchSaga } = useQuery<{ saga: Saga | null }>(Q_SAGA, { id: sagaId ?? '' }, sagaId ? 1500 : undefined, [sagaId], !sagaId);
  const saga = sagaId ? sagaData?.saga ?? undefined : undefined;

  const wallet = wallets?.find((w) => w.fleetId === fleetId);

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const d = await gql<{ reserveAndCharge: Saga }>(M_RESERVE, {
        input: { fleetId, ...selected, energyKwh: energy, fastChargeBoost: boost, idempotencyKey: crypto.randomUUID() },
      });
      setSagaId(d.reserveAndCharge.sagaId);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function stop() {
    if (!sagaId) return;
    setSubmitting(true);
    try {
      await gql(M_STOP, { id: sagaId });
      await refetchSaga();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Reservar y activar carga</h2>
        <span className="muted small">SAGA orquestada</span>
      </div>

      {faultFlag && (
        <p className="banner banner-bad small">
          SIMULATE_CHARGER_HARDWARE_FAULT activa: el paso 3 fallará y verás el rollback distribuido.
        </p>
      )}

      <div className="form">
        <label>
          Flota
          <select value={fleetId} onChange={(e) => setFleetId(e.target.value)}>
            {wallets?.map((w) => (
              <option key={w.fleetId} value={w.fleetId}>
                {w.fleetName}
              </option>
            ))}
          </select>
          <span className="muted small">Saldo {fmtMoney(wallet?.balance, wallet?.currency)}</span>
        </label>

        <label>
          Conector
          <select
            value={selected ? `${selected.stationId}|${selected.connectorId}` : ''}
            onChange={(e) => {
              const [s, c] = e.target.value.split('|');
              if (s) onSelect(s, c);
            }}
          >
            <option value="">Elige uno libre (o haz clic en el panel)</option>
            {stations?.flatMap((s) =>
              s.connectors
                .filter((c) => c.status === 'AVAILABLE' || (s.stationId === selected?.stationId && c.connectorId === selected.connectorId))
                .map((c) => (
                  <option key={`${s.stationId}|${c.connectorId}`} value={`${s.stationId}|${c.connectorId}`}>
                    {s.name} · {c.connectorId.toUpperCase()} · {c.powerKw} kW
                  </option>
                )),
            )}
          </select>
        </label>

        <label>
          Energía: <strong>{energy} kWh</strong>
          <input type="range" min={5} max={120} step={5} value={energy} onChange={(e) => setEnergy(Number(e.target.value))} />
        </label>

        <label className={`check ${canBoost ? '' : 'disabled'}`}>
          <input type="checkbox" checked={boost} disabled={!canBoost} onChange={(e) => setBoost(e.target.checked)} />
          <span>
            Reserva prioritaria ultra-carga (+15%)
            <span className="muted small">
              {' '}
              {!boostEnabled ? '· ENABLE_FAST_CHARGE_BOOST apagada en este ambiente' : !connector?.ultraFast && selected ? '· requiere conector ≥150 kW' : ''}
            </span>
          </span>
        </label>

        {selected && (
          <div className="quote">
            {quoteErr ? (
              <span className="error small">{quoteErr}</span>
            ) : quote ? (
              <>
                <span className="big">{fmtMoney(quote.amount, quote.currency)}</span>
                <span className="muted small">
                  {fmtMoney(quote.ratePerKwh)}/kWh
                  {quote.surgeActive ? ` · tarifa dinámica x${quote.surgeMultiplier}${quote.peakHour ? ' (hora pico)' : ''}` : ' · tarifa plana'}
                  {quote.boostFee ? ` · recargo ${fmtMoney(quote.boostFee)}` : ''}
                </span>
              </>
            ) : (
              <span className="muted small">Cotizando…</span>
            )}
          </div>
        )}

        <button className="btn" disabled={!selected || submitting} onClick={submit}>
          {submitting ? 'Ejecutando SAGA…' : 'Reservar y activar'}
        </button>
        {error && <p className="error small">{error}</p>}
      </div>

      {saga && <SagaTimeline saga={saga} onStop={stop} busy={submitting} />}
    </section>
  );
}
