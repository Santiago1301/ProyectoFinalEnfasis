import { Fragment, useState } from 'react';
import { fmtMoney, fmtTime, gql } from '../api';
import { M_RETRY } from '../queries';
import type { Saga } from '../types';
import { STATUS_TONE } from '../status';

const SHORT: Record<string, string> = {
  QUOTE: 'Cotizar',
  VALIDATE: 'Validar',
  RESERVE: 'Reservar',
  CHARGE: 'Cobrar',
  DISPATCH: 'Activar',
  ACTIVATE: 'En carga',
  COMPENSATE_DISPATCH: '↩ Detener',
  COMPENSATE_CHARGE: '↩ Reembolso',
  COMPENSATE_RESERVE: '↩ Liberar',
  STOP: 'Finalizada',
};

export function SagaHistory({ sagas, onChanged }: { sagas?: Saga[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const counts = (sagas ?? []).reduce<Record<string, number>>((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {});

  async function retry(id: string) {
    setBusy(id);
    try {
      await gql(M_RETRY, { id });
      onChanged();
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Historial de transacciones SAGA</h2>
        <div className="counts">
          {Object.entries(counts).map(([k, v]) => (
            <span key={k} className={`pill pill-${STATUS_TONE[k] ?? 'neutral'}`}>
              {k} {v}
            </span>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Estado</th>
              <th>Flota</th>
              <th>Conector</th>
              <th className="num">Monto</th>
              <th>Pasos y compensaciones</th>
            </tr>
          </thead>
          <tbody>
            {!sagas?.length && (
              <tr>
                <td colSpan={6} className="muted">
                  Aún no hay transacciones en este ambiente.
                </td>
              </tr>
            )}
            {sagas?.map((s) => (
              <Fragment key={s.sagaId}>
                <tr className="row" onClick={() => setOpen(open === s.sagaId ? undefined : s.sagaId)}>
                  <td className="mono small">{fmtTime(s.createdAt)}</td>
                  <td>
                    <span className={`pill pill-${STATUS_TONE[s.status] ?? 'neutral'}`}>{s.status}</span>
                  </td>
                  <td className="small">{s.fleetId}</td>
                  <td className="small">
                    {s.stationId} · {s.connectorId.toUpperCase()}
                  </td>
                  <td className="num small">{fmtMoney(s.amount, s.currency ?? 'COP')}</td>
                  <td>
                    <div className="chips">
                      {s.steps
                        .filter((st) => st.name !== 'QUOTE')
                        .map((st, i) => (
                          <span key={i} className={`chip chip-${st.status} ${st.name.startsWith('COMPENSATE') ? 'chip-comp' : ''}`}>
                            {SHORT[st.name] ?? st.name}
                          </span>
                        ))}
                    </div>
                  </td>
                </tr>
                {open === s.sagaId && (
                  <tr className="detail">
                    <td colSpan={6}>
                      <p className="mono small">correlation_id: {s.sagaId}</p>
                      {s.failureReason && <p className="small">Motivo: {s.failureReason}</p>}
                      <ul className="small">
                        {s.steps.map((st, i) => (
                          <li key={i}>
                            <span className="mono">{fmtTime(st.at)}</span> {st.name} — {st.status}
                            {st.detail ? ` · ${st.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                      {(s.status === 'COMPENSATION_FAILED' || s.status === 'COMPENSATING') && (
                        <button className="btn btn-secondary" disabled={busy === s.sagaId} onClick={() => retry(s.sagaId)}>
                          Reintentar compensación
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
