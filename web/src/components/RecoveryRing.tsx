import { useI18n } from '../i18n';

/**
 * The signature of the product, drawn from the Talos mark: a ring with
 * three points around an emerald core.
 *
 * The ring fills with emerald as money is recovered. The three points sit
 * where they sit in the logo (top, lower right, lower left) and stand for
 * the stages a debt goes through: reminders, promises, legal. The emerald
 * core of the logo becomes the recovered share in the middle. The ring
 * draws itself once when the page opens (not when reduced motion is on).
 */
export interface RingStage {
  label: string;
  value: string; // already formatted
}

const R = 100;
const C = 2 * Math.PI * R;

export function RecoveryRing({
  pct,
  stages,
  size = 260,
}: {
  /** Recovered share, "43.4" or null if nothing is owed. */
  pct: string | null;
  stages: [RingStage, RingStage, RingStage];
  size?: number;
}) {
  const { t, dir } = useI18n();
  // Display only: a percentage, not an amount, so a number is fine here.
  const fraction = pct === null ? 0 : Math.min(1, Math.max(0, Number(pct) / 100));
  const [whole, tenth] = (pct ?? '0.0').split('.');
  // Points at 12, 4 and 8 o'clock, as in the logo. Labels sit outside the ring.
  const points = [
    { x: 0, y: -R, lx: 0, ly: -R - 34, anchor: 'middle' as const },
    { x: R * Math.cos(Math.PI / 6), y: R * Math.sin(Math.PI / 6), lx: R * 0.87 + 30, ly: R * 0.5 + 34, anchor: 'start' as const },
    { x: -R * Math.cos(Math.PI / 6), y: R * Math.sin(Math.PI / 6), lx: -R * 0.87 - 30, ly: R * 0.5 + 34, anchor: 'end' as const },
  ];
  // In Arabic the lower points swap sides with their labels, so reading order stays right to left.
  const order = dir === 'rtl' ? [stages[0], stages[2], stages[1]] : stages;

  return (
    <figure className="ring" style={{ width: size }} aria-label={`${whole}.${tenth}% ${t('overview.share')}`}>
      <svg viewBox="-190 -170 380 360" width={size} aria-hidden="true">
        <circle r={R} className="ring-track" />
        <circle
          r={R}
          className="ring-fill"
          strokeDasharray={`${C * fraction} ${C}`}
          style={{ ['--ring-length' as string]: `${C}` }}
          transform="rotate(-90)"
        />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={13} className="ring-node" />
            <text x={p.lx} y={p.ly - 9} textAnchor={p.anchor} className="ring-node-value">
              {order[i]!.value}
            </text>
            <text x={p.lx} y={p.ly + 11} textAnchor={p.anchor} className="ring-node-label">
              {order[i]!.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="ring-center">
        <span className="ring-pct">
          {whole}
          <span className="ring-pct-small">.{tenth}%</span>
        </span>
        <span className="ring-pct-label">{t('overview.share')}</span>
      </figcaption>
    </figure>
  );
}
