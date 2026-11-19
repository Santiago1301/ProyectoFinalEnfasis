import { fmtMoney, fmtTime } from '../api';
import type { Saga } from '../types';
import { STATUS_TONE } from '../status';
import { Sparkline } from './Sparkline';

const STEP_LABEL: Record<string, string> = {
  VALIDATE: 'Validación',
  QUOTE: 'Cotización',
  RESERVE: '1 · Reservar conector',
  CHARGE: '2 · Cobrar billetera',
  DISPATCH: '3 · Activar cargador',
  ACTIVATE: 'Conector en carga',
  COMPENSATE_DISPATCH: '↩ Detener sesión',
  COMPENSATE_CHARGE: '↩ Reembolsar saldo',
  COMPENSATE_RESERVE: '↩ Liberar conector',
  STOP: 'Carga finalizada',
};


export function SagaTimeline({ saga, onStop, busy }: { saga: Saga; onStop?: () => void; busy?: boolean }) {
  const stopped = saga.steps.some((s) => s.name === 'STOP');
  const s = saga.session;
  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className={`pill pill-${STATUS_TONE[saga.status] ?? 'neutral'}`}>{saga.status}</span>
        <span className="mono small muted" title={saga.sagaId}>
          correlation_id {saga.sagaId.slice(0, 8)}…
        </span>
      </div>
      <ol>
        {saga.steps.map((st, i) => (
          <li key={i} className={`step step-${st.status} ${st.name.startsWith('COMPENSATE') ? 'step-comp' : ''}`}>
            <i />
            <div>
              <strong>{STEP_LABEL[st.name] ?? st.name}</strong>
              <span className="muted small"> {fmtTime(st.at)}</span>
              {st.detail && <p className="small">{st.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      {s && s.status !== 'FAILED' && (
        <div className="session">
          <div className="session-row">
            <span>
              {s.deliveredKwh.toFixed(1)} / {s.energyKwhTarget} kWh
            </span>
            <span className="muted small">{s.status}</span>
          </div>
          <div className="bar">
            <div style={{ width: `${Math.min(100, (s.deliveredKwh / s.energyKwhTarget) * 100)}%` }} />
          </div>
          <Sparkline values={s.telemetry.map((t) => t.deliveredKwh)} max={s.energyKwhTarget} label="Energía entregada" unit=" kWh" />
          <span className="muted small">
            Potencia actual {s.telemetry.at(-1)?.powerKw.toFixed(1) ?? s.powerKw} kW · SoC {s.telemetry.at(-1)?.stateOfCharge.toFixed(0) ?? '—'}%
          </span>
        </div>
      )}
      {saga.status === 'COMPLETED' && !stopped && onStop && (
        <button className="btn btn-secondary" onClick={onStop} disabled={busy}>
          Finalizar carga y liberar conector
        </button>
      )}
      {saga.amount != null && (
        <p className="muted small">
          Monto {fmtMoney(saga.amount, saga.currency ?? 'COP')}
          {saga.surgeMultiplier && saga.surgeMultiplier > 1 ? ` · tarifa dinámica x${saga.surgeMultiplier}` : ''}
        </p>
      )}
    </div>
  );
}
