/** Rounds a step up to 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Axis ticks from zero to a round maximum at or above `max` (about `count` intervals). */
export function niceTicks(max: number, count = 4): readonly number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / count);
  const ticks: number[] = [];
  for (let v = 0; v < max + step - 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max)
    ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** The indexes of x labels to print so they never overlap: at most `max`, always the first and last. */
export function labelIndexes(length: number, max: number): readonly number[] {
  if (length <= 0 || max < 1) return [];
  if (length <= max) return Array.from({ length }, (_, i) => i);
  if (max === 1) return [0];
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(Math.round((k * (length - 1)) / (max - 1)));
  return [...out];
}

/** A compact axis figure: 1.2k, 3.4M; small figures stay whole. */
export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value * 100) / 100);
}
function trim(v: number): string {
  return String(Math.round(v * 10) / 10);
}
