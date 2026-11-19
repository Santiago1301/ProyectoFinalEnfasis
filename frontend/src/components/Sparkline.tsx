export function Sparkline({ values, label, max: maxValue, unit = '' }: { values: number[]; label: string; max?: number; unit?: string }) {
  if (values.length < 2) return <p className="muted small">Esperando telemetría…</p>;
  const w = 280;
  const h = 48;
  const max = maxValue ?? Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`).join(' ');
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="muted small">
        {label}: {values[values.length - 1].toFixed(1)}
        {unit}
      </figcaption>
    </figure>
  );
}
