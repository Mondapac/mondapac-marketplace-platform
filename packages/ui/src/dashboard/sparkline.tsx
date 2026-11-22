const W = 80;
const H = 28;
const PAD = 2;

/**
 * A tiny trend line for a stat card, drawn from the chart tokens. Decoration only: the card's
 * figure and change line carry the meaning, so it is hidden from assistive technology.
 */
export function Sparkline({ values: raw }: { readonly values: readonly number[] }) {
  const values = raw.filter(Number.isFinite);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const span = flat ? 1 : max - min;
  const step = (W - PAD * 2) / (values.length - 1);
  const points = values
    .map(
      (v, i) =>
        `${(PAD + i * step).toFixed(1)},${(flat ? H / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${W} ${H}`}
      className="h-7 w-20 shrink-0 overflow-visible"
      data-sparkline=""
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className="stroke-chart-series"
      />
    </svg>
  );
}
