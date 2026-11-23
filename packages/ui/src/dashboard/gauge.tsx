import { ChartEmpty } from './chart-states.tsx';

interface GaugeBase {
  /** The text alternative's subject ("Store health"). */
  readonly label: string;
  /** The reading; null or not finite shows the empty state. */
  readonly value: number | null;
  /** The top of the scale (100 for a score out of 100). A value of 0 or less shows the empty state. */
  readonly max?: number;
  /** Formats the figure, the target and the maximum; defaults to the rounded number. */
  readonly formatValue?: (value: number) => string;
  /**
   * The reading as shown in the centre. Keep it short (about 6 characters): longer text shrinks
   * and is cut with an ellipsis (the full text is in the tooltip and the text alternative).
   */
  readonly display?: string;
  /** A muted line under the figure ("out of 100"). Without it the text alternative says "of {max}". */
  readonly caption?: string;
  /** Said when there is no reading yet. */
  readonly emptyLabel: string;
}

/** A goal drawn as a tick on the arc needs its name for the text alternative. */
export type GaugeProps = GaugeBase &
  (
    | { readonly target?: undefined; readonly targetLabel?: undefined }
    | { readonly target: number; readonly targetLabel: string }
  );

const CX = 100;
const CY = 100;
const R = 80;
const STROKE = 16;
/** Below this share the arc is not drawn (it would be a dot, or hide a real zero). */
const MIN_FRACTION = 0.01;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** A point on the half circle: 0 is the left end, 1 the right end. */
function at(fraction: number, radius: number) {
  const angle = Math.PI * (1 - fraction);
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)] as const;
}

const figureSize = (text: string) =>
  text.length > 9 ? 'text-base' : text.length > 6 ? 'text-xl' : 'text-3xl';

/**
 * A semicircle gauge from 0 to `max` in one hue: a track, the filled part and an optional target
 * tick. The figure is printed in the centre and said in the text alternative, so the arc is a
 * scale cue only. A value outside 0..max clamps the arc to the ends; the raw figure is still
 * printed. The same holds for the target tick.
 */
export function Gauge({
  label,
  value,
  max = 100,
  formatValue = (n) => String(Math.round(n)),
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
  const shown = display ?? formatValue(value);
  const hasTarget = target !== undefined && Number.isFinite(target);
  const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`;
  const tick =
    hasTarget && target !== undefined
      ? {
          from: at(clamp01(target / max), R - STROKE / 2 - 3),
          to: at(clamp01(target / max), R + STROKE / 2 + 3),
        }
      : null;
  const text = `${label}: ${shown} ${caption ?? `of ${formatValue(max)}`}${
    hasTarget && target !== undefined ? `, ${targetLabel} ${formatValue(target)}` : ''
  }`;
  return (
    <div
      role="img"
      aria-label={text}
      data-chart="gauge"
      className="relative my-auto w-full max-w-64 self-center"
    >
      <svg aria-hidden="true" focusable="false" viewBox="0 0 200 112" className="block w-full">
        <path d={arc} fill="none" strokeWidth={STROKE} className="stroke-chart-track" />
        {fraction >= MIN_FRACTION ? (
          <path
            d={arc}
            fill="none"
            strokeWidth={STROKE}
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
        className="absolute inset-x-0 bottom-0 flex flex-col items-center px-8 leading-tight"
      >
        <span
          title={shown}
          className={`max-w-full truncate font-semibold text-fg ${figureSize(shown)}`}
        >
          {shown}
        </span>
        {caption === undefined ? null : <span className="text-xs text-fg-muted">{caption}</span>}
      </div>
    </div>
  );
}
