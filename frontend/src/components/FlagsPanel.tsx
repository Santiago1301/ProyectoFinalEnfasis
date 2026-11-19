import { useState } from 'react';
import { fmtTime, gql } from '../api';
import { M_FLAG } from '../queries';
import type { Env, FeatureFlag } from '../types';

interface Props {
  flags?: FeatureFlag[];
  env?: Env;
  mutationsAllowed: boolean;
  onChanged: (f: FeatureFlag) => void;
}

export function FlagsPanel({ flags, env, mutationsAllowed, onChanged }: Props) {
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();

  async function toggle(f: FeatureFlag) {
    setPending(f.name);
    setError(undefined);
    try {
      const d = await gql<{ setFeatureFlag: FeatureFlag }>(M_FLAG, { name: f.name, enabled: !f.enabled });
      onChanged(d.setFeatureFlag);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Feature flags</h2>
        <span className="muted small mono">aegisvolt-feature-flags-{env ?? '…'}</span>
      </div>
      {!mutationsAllowed && env && (
        <p className="banner small">En {env} las flags sólo cambian por pipeline / IaC; aquí son de sólo lectura.</p>
      )}
      <ul className="flags">
        {flags?.map((f) => (
          <li key={f.name}>
            <div>
              <code>{f.name}</code>
              <p className="muted small">{f.description}</p>
              <p className="muted small">
                {f.updatedBy ?? 'terraform'} {f.updatedAt ? `· ${fmtTime(f.updatedAt)}` : ''}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={f.enabled}
              aria-label={f.name}
              className={`switch ${f.enabled ? 'on' : ''}`}
              disabled={!mutationsAllowed || pending === f.name}
              onClick={() => toggle(f)}
            >
              <span />
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
