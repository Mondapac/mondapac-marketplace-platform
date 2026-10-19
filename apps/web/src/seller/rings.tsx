import { useTranslations } from 'next-intl';

// The seller page's performance rings. The ring colour is heat-coded by value, interpolated
// between these stops (50 or less red, 65 orange, 78 yellow, 90 light green, 100 dark green); the
// number in the centre always carries the value, so colour is never the only signal.
const HEAT: readonly (readonly [number, readonly [number, number, number]])[] = [
  [50, [198, 40, 40]],
  [65, [239, 108, 0]],
  [78, [242, 194, 0]],
  [90, [124, 179, 66]],
  [100, [27, 94, 32]],
];

/** The ring colour of a whole percent. */
export function heat(value: number): string {
  const rgb = (c: readonly number[]) => `rgb(${c.join(', ')})`;
  const [first] = HEAT;
  if (value <= first![0]) return rgb(first![1]);
  for (let i = 1; i < HEAT.length; i++) {
    const [to, end] = HEAT[i]!;
    if (value <= to) {
      const [from, start] = HEAT[i - 1]!;
      const t = (value - from) / (to - from);
      return rgb(start.map((c, k) => Math.round(c + (end[k]! - c) * t)));
    }
  }
  return rgb(HEAT[HEAT.length - 1]![1]);
}

export function Ring({ label, value }: { readonly label: string; readonly value: number }) {
  const t = useTranslations('seller');
  return (
    <div className="shop-ring" role="img" aria-label={t('ring', { label, value })}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle className="tr" cx="40" cy="40" r="32" />
        <circle
          className="vl"
          cx="40"
          cy="40"
          r="32"
          pathLength={100}
          strokeDasharray={`${value} 100`}
          style={{ stroke: heat(value) }}
        />
        <text x="40" y="47" textAnchor="middle">
          {value}%
        </text>
      </svg>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
