import { ChartEmpty } from './chart-states.tsx';

export interface GaugeProps {
  /** The text alternative's subject ("Store health"). */
  readonly label: string;
  /** The reading; null or not finite shows the empty state. */
  readonly value: number | null;
  /** The top of the scale (100 for a score out of 100). */
  readonly max?: number;
  /** The reading as shown in the centre ("82"). Defaults to the rounded value. */
  readonly display?: string;
  /** A muted line under the figure ("out of 100"). */
  readonly caption?: string;
  /** A goal drawn as a tick on the arc. */
  readonly target?: number;
  /** Names the target in the text alternative ("Target"). */
  readonly targetLabel?: string;
  /** Said when there is no reading yet. */
  readonly emptyLabel: string;
}

const CX = 100;
const CY = 100;
const R = 80;
const STROKE = 16;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** A point on the half circle: 0 is the left end, 1 the right end. */
function at(fraction: number, radius: number) {
  const angle = Math.PI * (1 - fraction);
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)] as const;
}

/**
 * A semicircle gauge from 0 to `max` in one hue: a track, the filled part and an optional target
 * tick. The figure is printed in the centre and said in the text alternative, so the arc is a
 * scale cue only.
 */
export function Gauge({
  label,
  value,
  max = 100,
  display,
  caption,
  target,
  targetLabel,
  emptyLabel,
}: GaugeProps) {
  if (value === null || !Number.isFinite(value) || !(max > 0)) {
    return <ChartEmpty message={emptyLabel} height={120} />;
  }
  const fraction = clamp01(value / max);
  const shown = display ?? String(Math.round(value));
  const hasTarget = target !== undefined && Number.isFinite(target);
  const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  const tick =
    hasTarget && target !== undefined
      ? {
          from: at(clamp01(target / max), R - STROKE / 2 - 3),
          to: at(clamp01(target / max), R + STROKE / 2 + 3),
        }
      : null;
  const text = `${label}: ${shown}${caption === undefined ? '' : ` ${caption}`}${
    hasTarget ? `, ${targetLabel ?? ''} ${target}`.replace(/\s+/g, ' ') : ''
  }`;
  return (
    <div
      role="img"
      aria-label={text}
      data-chart="gauge"
      className="relative mx-auto w-full max-w-64"
    >
      <svg aria-hidden="true" focusable="false" viewBox="0 0 200 112" className="block w-full">
        <path
          d={arc}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          className="stroke-chart-track"
        />
        {fraction > 0 ? (
          <path
            d={arc}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${fraction * 100} 100`}
            className="stroke-chart-series"
            data-gauge="value"
          />
        ) : null}
        {tick === null ? null : (
          <line
            x1={tick.from[0]}
            y1={tick.from[1]}
            x2={tick.to[0]}
            y2={tick.to[1]}
            strokeWidth={2.5}
            className="stroke-fg"
            data-gauge="target"
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 flex flex-col items-center leading-tight"
      >
        <span className="text-3xl font-semibold text-fg">{shown}</span>
        {caption === undefined ? null : <span className="text-xs text-fg-muted">{caption}</span>}
      </div>
    </div>
  );
}
