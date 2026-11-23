/** Categorical chart colours, in order (chart/cat-1 to cat-5 tokens) and the neutral "Other". Class names are literal so Tailwind finds them. */
export const CATEGORY_MAX = 5;

const FILL = [
  'fill-chart-cat-1',
  'fill-chart-cat-2',
  'fill-chart-cat-3',
  'fill-chart-cat-4',
  'fill-chart-cat-5',
] as const;
const STROKE = [
  'stroke-chart-cat-1',
  'stroke-chart-cat-2',
  'stroke-chart-cat-3',
  'stroke-chart-cat-4',
  'stroke-chart-cat-5',
] as const;
const BG = [
  'bg-chart-cat-1',
  'bg-chart-cat-2',
  'bg-chart-cat-3',
  'bg-chart-cat-4',
  'bg-chart-cat-5',
] as const;

export interface CategoryClasses {
  readonly fill: string;
  readonly stroke: string;
  readonly bg: string;
}

/** The classes of the n-th named category (0 based) or of "Other" when `index` is -1. */
export function categoryClasses(index: number): CategoryClasses {
  if (index < 0 || index >= CATEGORY_MAX)
    return {
      fill: 'fill-chart-cat-other',
      stroke: 'stroke-chart-cat-other',
      bg: 'bg-chart-cat-other',
    };
  return { fill: FILL[index]!, stroke: STROKE[index]!, bg: BG[index]! };
}
