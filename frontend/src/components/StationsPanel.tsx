import type { Station } from '../types';

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: 'Disponible',
  RESERVED: 'Reservado',
  CHARGING: 'Cargando',
  FAULTED: 'Falla',
};

interface Props {
  stations?: Station[];
  mode: string;
  selected?: { stationId: string; connectorId: string };
  onSelect: (stationId: string, connectorId: string) => void;
}

export function StationsPanel({ stations, mode, selected, onSelect }: Props) {
  const total = stations?.reduce((n, s) => n + s.connectors.length, 0) ?? 0;
  const available = stations?.reduce((n, s) => n + s.availableConnectors, 0) ?? 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Electrolineras</h2>
        <span className="muted small">
          {available}/{total} conectores libres ·{' '}
          <span className={mode === 'wss' ? 'live' : ''}>{mode === 'wss' ? 'en vivo (WSS)' : mode === 'polling' ? 'polling' : '…'}</span>
        </span>
      </div>
      <div className="legend small muted">
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <span key={k}>
            <i className={`swatch st-${k}`} /> {v}
          </span>
        ))}
      </div>
      <div className="stations">
        {!stations && <p className="muted">Cargando…</p>}
        {stations?.map((s) => (
          <article key={s.stationId} className="station">
            <header>
              <div>
                <h3>{s.name}</h3>
                <p className="muted small">
                  {s.city} · {s.address}
                </p>
              </div>
              <span className="count">{s.availableConnectors}</span>
            </header>
            <div className="connectors">
              {s.connectors.map((c) => {
                const isSel = selected?.stationId === s.stationId && selected.connectorId === c.connectorId;
                return (
                  <button
                    key={c.connectorId}
                    className={`connector st-${c.status} ${isSel ? 'selected' : ''}`}
                    disabled={c.status !== 'AVAILABLE'}
                    onClick={() => onSelect(s.stationId, c.connectorId)}
                    title={c.reservationSagaId ? `SAGA ${c.reservationSagaId}` : STATUS_LABEL[c.status]}
                  >
                    <span className="c-id">{c.connectorId.toUpperCase()}</span>
                    <span className="c-power">{c.powerKw} kW</span>
                    <span className="c-meta">
                      {c.plugType}
                      {c.ultraFast ? ' · ultra' : ''}
                    </span>
                    <span className="c-status">{STATUS_LABEL[c.status]}</span>
                  </button>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
