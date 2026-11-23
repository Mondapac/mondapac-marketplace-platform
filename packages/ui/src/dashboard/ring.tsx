import { ChartEmpty } from './chart-states.tsx';

export interface RingProps {
  /** The text alternative's subject ("Same-day shipping"). */
  readonly label: string;
  /** Share from 0 to 100; null or not finite shows the empty state. */
  readonly percent: number | null;
  /** The centre figure as shown; defaults to the rounded percentage ("94%"). */
  readonly display?: string;
  /** A muted line in the centre under the figure ("on time"). */
  readonly caption?: string;
  /** Pixel size of the ring (default 120). */
  readonly size?: number;
  readonly emptyLabel: string;
}

/** A progress ring in one hue with its figure in the centre; the figure is also the text alternative. */
export function Ring({ label, percent, display, caption, size = 120, emptyLabel }: RingProps) {
  if (percent === null || !Number.isFinite(percent)) {
    return <ChartEmpty message={emptyLabel} height={size} />;
  }
  const pct = Math.max(0, Math.min(100, percent));
  const shown = display ?? `${Math.round(pct)}%`;
  const stroke = 12;
  const r = 50 - stroke / 2;
  return (
    <div
      role="img"
      aria-label={`${label}: ${shown}${caption === undefined ? '' : ` ${caption}`}`}
      data-chart="ring"
      className="relative mx-auto"
      style={{ width: size, height: size }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 100 100"
        className="block size-full -rotate-90"
      >
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-chart-track"
        />
        {pct > 0 ? (
          <circle
            cx={50}
            cy={50}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            className="stroke-chart-series"
            data-ring="value"
          />
        ) : null}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-0 flex flex-col items-center justify-center leading-tight"
      >
        <span className="text-2xl font-semibold text-fg">{shown}</span>
        {caption === undefined ? null : <span className="text-xs text-fg-muted">{caption}</span>}
      </div>
    </div>
  );
}
