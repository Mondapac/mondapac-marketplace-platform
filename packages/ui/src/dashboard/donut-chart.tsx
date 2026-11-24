'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { bucketCategories, type CategoryInput, type CategorySlice } from './chart-categories.ts';
import { colorClasses } from './chart-palette.ts';
import { fitFontSize, truncateText } from './chart-scale.ts';
import {
  ChartEmpty,
  chartStateMessage,
  type ChartDataState,
  type ChartEmptyLabels,
} from './chart-states.tsx';

/** One category. `value` is gross and non-negative; a negative or non-finite value is dropped. */
export type DonutSegment = CategoryInput;

export interface DonutChartProps {
  /** The text alternative and the table caption ("Sales by category, last 30 days"). */
  readonly title: string;
  /**
   * The categories. Values are gross, non-negative figures. At most five are named (the largest);
   * the rest are summed into "Other". Give each a `colorKey` so a category keeps its colour.
   */
  readonly segments: readonly DonutSegment[];
  /** Formats a value for the legend, the centre and the table ("A$1,204"). */
  readonly formatValue: (value: number) => string;
  /** Formats the total in the centre; defaults to `formatValue`. Use a compact format for big figures. */
  readonly formatCentre?: (value: number) => string;
  /** Formats a share (0 to 1); defaults to a whole or one-decimal percent. */
  readonly formatShare?: (share: number) => string;
  /** The label of the bucket that holds everything past the fifth category ("Other"). */
  readonly otherLabel: string;
  /** The word under the total in the centre ("Total"). */
  readonly totalLabel: string;
  /**
   * What to say when there is nothing to draw. Decided by the caller: `empty` (no data in the
   * period) or `insufficient` (some data, too little to read). Left out, a chart with no usable
   * value says `empty`; a state that is set is always shown.
   */
  readonly state?: ChartDataState;
  readonly emptyLabels?: Partial<ChartEmptyLabels>;
  /** A footnote for values that were dropped for being negative or not finite ("1 value left out"). */
  readonly droppedNote?: (dropped: number) => string;
  readonly size?: number;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly categoryColumn: string;
    readonly valueColumn: string;
    readonly shareColumn: string;
  };
}

const defaultShare = (share: number) => {
  const p = Math.round(share * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
};

/** The smallest arc a slice is drawn with (2 degrees), so a tiny category stays visible. */
export const MIN_ARC = (2 * Math.PI) / 180;

/** Arc widths (radians) for shares that add up to 1: none below `MIN_ARC`, the rest scaled to fit. */
export function arcWidths(shares: readonly number[]): number[] {
  const full = Math.PI * 2;
  const raw = shares.map((s) => s * full);
  const small = raw.filter((w) => w < MIN_ARC).length;
  const big = raw.reduce((sum, w) => (w < MIN_ARC ? sum : sum + w), 0);
  const scale = big > 0 ? (full - small * MIN_ARC) / big : 1;
  return raw.map((w) => (w < MIN_ARC ? MIN_ARC : w * scale));
}

/** Up to five named slices by size, then everything else as one "Other" slice. */
export function sliceSegments(
  segments: readonly DonutSegment[],
  otherLabel: string,
): CategorySlice[] {
  return bucketCategories(segments, otherLabel).slices;
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const pt = (a: number) =>
    `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${pt(from)} A${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${pt(to)}`;
}

/**
 * A donut of one total split into at most five named categories and an "Other" bucket. The
 * hovered or focused slice (or legend row) takes over the centre text instead of a floating
 * tooltip. Every figure is also printed in the legend, each segment can be focused (Tab, then
 * arrow keys), and "View as table" shows the same figures as text.
 */
export function DonutChart({
  title,
  segments,
  formatValue,
  formatCentre,
  formatShare = defaultShare,
  otherLabel,
  totalLabel,
  state,
  emptyLabels,
  droppedNote,
  size = 176,
  labels,
}: DonutChartProps) {
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const { slices, dropped } = bucketCategories(segments, otherLabel);
  if (state !== undefined || slices.length === 0)
    return <ChartEmpty message={chartStateMessage(state ?? 'empty', emptyLabels)} height={size} />;

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const thickness = Math.round(size * 0.14);
  const r = (size - thickness) / 2 - 1;
  const c = size / 2;
  const widths = arcWidths(slices.map((s) => s.share));
  const multiple = slices.length > 1;
  let cursor = -Math.PI / 2;
  const arcs = widths.map((w) => {
    const from = cursor;
    cursor += w;
    const pad = multiple ? Math.min(0.0175, w * 0.3) : 0;
    return { from: from + pad, to: Math.max(from + pad + 0.001, cursor - pad), full: !multiple };
  });
  const key = (e: KeyboardEvent<SVGGElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) {
      if (e.key === 'Escape') setActive(null);
      return;
    }
    e.preventDefault();
    const next = ((active ?? (step === 1 ? -1 : 0)) + step + slices.length) % slices.length;
    setActive(next);
    e.currentTarget.querySelectorAll<SVGElement>('[data-segment]')[next]?.focus();
  };
  const shown = active === null ? undefined : slices[active];
  const inner = (size - 2 * thickness) * 0.86;
  const centreFormat = formatCentre ?? formatValue;
  const bigText = shown === undefined ? centreFormat(total) : centreFormat(shown.value);
  const bigSize = fitFontSize(bigText, inner, 20);
  const labelText = truncateText(
    shown === undefined ? totalLabel : shown.label,
    Math.max(Math.floor(inner / 6.6), 6),
  );

  const toggle = (
    <button
      type="button"
      aria-controls={tableId}
      onClick={() => setTable((v) => !v)}
      className="shrink-0 text-sm font-medium text-link underline"
    >
      {table ? labels.viewAsChart : labels.viewAsTable}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div id={tableId}>
        {table ? (
          <div className="flex flex-col gap-3">
            <div className="flex justify-end">{toggle}</div>
            <div className="overflow-auto rounded-md border border-line">
              <table className="w-full text-sm">
                <caption className="sr-only">{title}</caption>
                <thead className="bg-muted text-fg-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {labels.categoryColumn}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {labels.valueColumn}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {labels.shareColumn}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {slices.map((s) => (
                    <tr key={s.id} className="border-t border-line-row">
                      <th
                        scope="row"
                        className="px-3 py-2 text-start font-normal text-fg-secondary"
                      >
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            data-swatch=""
                            className={`size-3 shrink-0 rounded-sm ${colorClasses(s.colorKey).bg}`}
                          />
                          <span className="min-w-0 break-words" title={s.label}>
                            {s.label}
                          </span>
                        </span>
                      </th>
                      <td className="px-3 py-2 text-end text-fg tabular-nums">
                        {formatValue(s.value)}
                      </td>
                      <td className="px-3 py-2 text-end text-fg-secondary tabular-nums">
                        {formatShare(s.share)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
            <div className="relative shrink-0" style={{ width: size, height: size }}>
              <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                role="group"
                aria-label={title}
                onKeyDown={key}
                data-chart="donut"
                className="block overflow-visible"
              >
                <circle
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  strokeWidth={thickness}
                  className="stroke-chart-grid"
                />
                {slices.map((s, i) => {
                  const a = arcs[i]!;
                  const cls = colorClasses(s.colorKey);
                  const label = `${s.label}: ${formatValue(s.value)}, ${formatShare(s.share)}`;
                  const w = thickness + (active === i ? 4 : 0);
                  return (
                    <g
                      key={s.id}
                      data-segment={s.id}
                      role="img"
                      aria-label={label}
                      tabIndex={i === (active ?? 0) ? 0 : -1}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                      onPointerEnter={() => setActive(i)}
                      onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
                      style={{ outline: 'none' }}
                    >
                      {a.full ? (
                        <circle
                          cx={c}
                          cy={c}
                          r={r}
                          fill="none"
                          strokeWidth={w}
                          className={cls.stroke}
                        />
                      ) : (
                        <path
                          d={arc(c, c, r, a.from, a.to)}
                          fill="none"
                          strokeWidth={w}
                          className={cls.stroke}
                        />
                      )}
                    </g>
                  );
                })}
                {active === null || arcs[active] === undefined ? null : (
                  <path
                    aria-hidden="true"
                    d={
                      arcs[active].full
                        ? arc(c, c, r + thickness / 2 + 5, -Math.PI / 2, Math.PI * 1.5 - 0.001)
                        : arc(c, c, r + thickness / 2 + 5, arcs[active].from, arcs[active].to)
                    }
                    fill="none"
                    strokeWidth={2}
                    className="stroke-focus"
                  />
                )}
                <g aria-hidden="true" data-centre="">
                  <text
                    x={c}
                    y={c - 2}
                    textAnchor="middle"
                    fontSize={bigSize}
                    fontWeight={600}
                    className="fill-fg"
                  >
                    {bigText}
                  </text>
                  <text
                    x={c}
                    y={c + 15}
                    textAnchor="middle"
                    fontSize={12}
                    className="fill-fg-muted"
                  >
                    {labelText}
                    {shown === undefined ? '' : ` · ${formatShare(shown.share)}`}
                  </text>
                </g>
              </svg>
              <div role="status" className="sr-only">
                {shown === undefined
                  ? ''
                  : `${shown.label}: ${formatValue(shown.value)}, ${formatShare(shown.share)}`}
              </div>
            </div>
            <div className="flex min-w-60 max-w-md flex-1 flex-col gap-2">
              <div className="flex justify-end">{toggle}</div>
              <ul className="flex flex-col text-sm" onPointerLeave={() => setActive(null)}>
                {slices.map((s, i) => (
                  <li
                    key={s.id}
                    data-legend={s.id}
                    onPointerEnter={() => setActive(i)}
                    className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md px-2 py-1 ${
                      active === i ? 'bg-muted' : ''
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-3 shrink-0 rounded-sm ${colorClasses(s.colorKey).bg}`}
                    />
                    <span className="min-w-0 break-words text-fg-secondary" title={s.label}>
                      {s.label}
                    </span>
                    <span className="min-w-20 text-end font-medium text-fg tabular-nums">
                      {formatValue(s.value)}
                    </span>
                    <span className="w-14 text-end text-fg-muted tabular-nums">
                      {formatShare(s.share)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
      {dropped > 0 && droppedNote !== undefined ? (
        <p className="text-xs text-fg-muted" data-dropped-note="">
          {droppedNote(dropped)}
        </p>
      ) : null}
    </div>
  );
}
