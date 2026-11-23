/**
 * Chart colours. A category slot (cat-1..cat-5, cat-other) or a status colour (for series that
 * mean an order state). The caller assigns the key so a category keeps its colour across
 * charts and periods; the rank-based fallback only fills slots nobody asked for.
 * Class names are literal so Tailwind finds them.
 */
export const CATEGORY_MAX = 5;

export type CategoryKey = 'cat-1' | 'cat-2' | 'cat-3' | 'cat-4' | 'cat-5' | 'cat-other';
export type StatusKey = 'status-success' | 'status-attention' | 'status-danger';
export type ColorKey = CategoryKey | StatusKey;

export interface ColorClasses {
  readonly fill: string;
  readonly stroke: string;
  readonly bg: string;
}

const CLASSES: Readonly<Record<ColorKey, ColorClasses>> = {
  'cat-1': { fill: 'fill-chart-cat-1', stroke: 'stroke-chart-cat-1', bg: 'bg-chart-cat-1' },
  'cat-2': { fill: 'fill-chart-cat-2', stroke: 'stroke-chart-cat-2', bg: 'bg-chart-cat-2' },
  'cat-3': { fill: 'fill-chart-cat-3', stroke: 'stroke-chart-cat-3', bg: 'bg-chart-cat-3' },
  'cat-4': { fill: 'fill-chart-cat-4', stroke: 'stroke-chart-cat-4', bg: 'bg-chart-cat-4' },
  'cat-5': { fill: 'fill-chart-cat-5', stroke: 'stroke-chart-cat-5', bg: 'bg-chart-cat-5' },
  'cat-other': {
    fill: 'fill-chart-cat-other',
    stroke: 'stroke-chart-cat-other',
    bg: 'bg-chart-cat-other',
  },
  'status-success': { fill: 'fill-success-fg', stroke: 'stroke-success-fg', bg: 'bg-success-fg' },
  'status-attention': {
    fill: 'fill-attention-solid',
    stroke: 'stroke-attention-solid',
    bg: 'bg-attention-solid',
  },
  'status-danger': {
    fill: 'fill-critical-solid',
    stroke: 'stroke-critical-solid',
    bg: 'bg-critical-solid',
  },
};

export function colorClasses(key: ColorKey): ColorClasses {
  return CLASSES[key];
}

const SLOTS: readonly CategoryKey[] = ['cat-1', 'cat-2', 'cat-3', 'cat-4', 'cat-5'];

/**
 * One colour per item, in order. A key the caller gave is kept unless an earlier item already
 * holds it ("cat-other" is reserved for the Other bucket and is never taken by a named item).
 * Every other item takes the first free slot cat-1..cat-5 in order, then "cat-other".
 */
export function assignColorKeys(requested: readonly (ColorKey | undefined)[]): ColorKey[] {
  const used = new Set<ColorKey>();
  const out: (ColorKey | undefined)[] = requested.map((k) => {
    if (k === undefined || k === 'cat-other' || !(k in CLASSES) || used.has(k)) return undefined;
    used.add(k);
    return k;
  });
  return out.map((k) => {
    if (k !== undefined) return k;
    const free = SLOTS.find((s) => !used.has(s));
    if (free === undefined) return 'cat-other';
    used.add(free);
    return free;
  });
}
