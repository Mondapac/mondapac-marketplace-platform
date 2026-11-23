/** Rounds a step up to 1, 2, 5 or 10 times a power of ten. */
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

/** Ticks from at or below `min` to at or above `max` (zero is always inside); handles negative values. */
export function niceTicksRange(min: number, max: number, count = 4): readonly number[] {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const hi = Math.max(0, Number.isFinite(max) ? max : 0);
  if (hi === 0 && lo === 0) return [0, 1];
  const step = niceStep((hi - lo) / count);
  const start = Math.floor(lo / step + 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v < hi + step - 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < hi)
    ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/**
 * Splits `values` into the `max` largest (indexes, largest first, ties in input order) and the
 * rest. Used to show at most five named categories and one "Other" bucket. Values that are not
 * finite or not above zero are ignored.
 */
export function splitTop(
  values: readonly number[],
  max: number,
): { readonly top: readonly number[]; readonly rest: readonly number[] } {
  const ranked = values
    .map((v, i) => ({ v, i }))
    .filter((x) => Number.isFinite(x.v) && x.v > 0)
    .sort((a, b) => b.v - a.v || a.i - b.i);
  return {
    top: ranked.slice(0, max).map((x) => x.i),
    rest: ranked.slice(max).map((x) => x.i),
  };
}

/** Every `stride`-th index from 0, with the stride set so labels keep `minPx` of room. */
export function strideIndexes(length: number, slotPx: number, minPx = 64): readonly number[] {
  if (length <= 0) return [];
  const stride = Math.max(1, Math.ceil(minPx / Math.max(slotPx, 1)));
  const out: number[] = [];
  for (let i = 0; i < length; i += stride) out.push(i);
  return out;
}

/** A font size (px) that lets `text` fit `maxWidth`, between `min` and `max` (about 0.58 em per character). */
export function fitFontSize(text: string, maxWidth: number, max: number, min = 11): number {
  const size = maxWidth / (Math.max(text.length, 1) * 0.58);
  return Math.max(min, Math.min(max, Math.floor(size)));
}

/** `text` cut to `maxChars` with an ellipsis. */
export function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(maxChars - 1, 1))}…`;
}
