import { useEffect, useState } from 'react';
import { getEndpoint } from '../api';
import type { EnvironmentInfo } from '../types';

interface Props {
  env?: EnvironmentInfo;
  error?: string;
  onEndpoint: (url: string) => void;
}

export function Header({ env, error, onEndpoint }: Props) {
  const [endpoints, setEndpoints] = useState<{ label: string; url: string }[]>([]);
  useEffect(() => {
    fetch('/config.json')
      .then((r) => r.json())
      .then((c) => setEndpoints(c.endpoints ?? []))
      .catch(() => setEndpoints([{ label: 'Este despliegue', url: '/graphql' }]));
  }, []);
  const current = getEndpoint();
  const options = endpoints.some((e) => e.url === current) ? endpoints : [...endpoints, { label: current, url: current }];

  return (
    <header className="header">
      <div className="brand">
        <svg viewBox="0 0 24 24" aria-hidden width="26" height="26">
          <path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7z" />
        </svg>
        <div>
          <strong>AegisVolt</strong>
          <span className="muted small">Consola de carga para flotas</span>
        </div>
      </div>

      <div className="header-right">
        {error ? (
          <span className="pill pill-bad">Sin conexión al gateway</span>
        ) : env ? (
          <>
            <span className={`env-badge env-${env.environment}`} title="Ambiente reportado por el gateway GraphQL">
              {env.environment.toUpperCase()}
            </span>
            <div className="services" aria-label="Salud de microservicios">
              {env.services.map((s) => (
                <span key={s.name} className="service" title={`${s.name} ${s.version ?? ''} (${s.track ?? ''}) ${s.latencyMs ?? ''} ms`}>
                  <i className={s.status === 'UP' ? 'dot dot-up' : 'dot dot-down'} />
                  {s.name.replace('-service', '').replace('graphql-', '')}
                </span>
              ))}
            </div>
            <span className="muted small mono">{env.version}</span>
          </>
        ) : (
          <span className="muted small">Conectando…</span>
        )}
        <select className="endpoint" value={current} onChange={(e) => onEndpoint(e.target.value)} aria-label="Endpoint GraphQL">
          {options.map((e) => (
            <option key={e.url} value={e.url}>
              {e.label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
