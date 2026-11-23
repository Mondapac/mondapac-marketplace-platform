'use client';

import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { assignColorKeys, CATEGORY_MAX, colorClasses, type ColorKey } from './chart-palette.ts';
import { compactNumber, niceTicks, splitTop, strideIndexes } from './chart-scale.ts';
import {
  ChartEmpty,
  chartStateMessage,
  type ChartDataState,
  type ChartEmptyLabels,
} from './chart-states.tsx';
import { useWidth } from './use-width.ts';

export interface StackedSeries {
  readonly id: string;
  readonly label: string;
  /** The colour of this series (a category slot or a status colour); see chart-palette. */
  readonly colorKey?: ColorKey;
}

export interface StackedPoint {
  /** The x label as shown ("12 Nov"). */
  readonly label: string;
  /** Gross, non-negative figures by series id; a negative or non-finite value is dropped, a missing id counts as 0. */
  readonly values: Readonly<Record<string, number>>;
}

export interface StackedBarChartProps {
  /** The text alternative and the table caption ("Orders by source, last 14 days"). */
  readonly title: string;
  readonly series: readonly StackedSeries[];
  readonly points: readonly StackedPoint[];
  readonly formatValue: (value: number) => string;
  readonly formatTick?: (value: number) => string;
  /** The label of the bucket that holds every series past the fifth ("Other"). */
  readonly otherLabel: string;
  readonly totalLabel: string;
  /** Decided by the caller: no data in the period, or too little to read. */
  readonly state?: ChartDataState;
  readonly emptyLabels?: Partial<ChartEmptyLabels>;
  /** A footnote for values dropped for being negative or not finite. */
  readonly droppedNote?: (dropped: number) => string;
  readonly height?: number;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly dateColumn: string;
    /** Muted hint in the readout band while no column is active. */
    readonly readoutHint?: string;
  };
}

const AXIS_W = 52;
const PAD = { top: 8, right: 8, bottom: 22 };

interface Column {
  readonly id: string;
  readonly label: string;
  readonly colorKey: ColorKey;
  readonly values: readonly number[];
}

const clean = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);
const isDropped = (v: number | undefined) => v !== undefined && (!Number.isFinite(v) || v < 0);

/**
 * Up to five named series by their total over the WHOLE period, the rest summed into "Other".
 * So which series fall into "Other" depends on the period shown, but a series with a `colorKey`
 * keeps its colour wherever it lands.
 */
export function stackSeries(
  series: readonly StackedSeries[],
  points: readonly StackedPoint[],
  otherLabel: string,
): Column[] {
  const rows = series.map((s) => points.map((p) => clean(p.values[s.id])));
  const { top, rest } = splitTop(
    rows.map((r) => r.reduce((a, b) => a + b, 0)),
    CATEGORY_MAX,
  );
  const keys = assignColorKeys(top.map((i) => series[i]!.colorKey));
  const cols: Column[] = top.map((i, k) => ({
    id: series[i]!.id,
    label: series[i]!.label,
    colorKey: keys[k]!,
    values: rows[i]!,
  }));
  if (rest.length > 0)
    cols.push({
      id: '__other',
      label: otherLabel,
      colorKey: 'cat-other',
      values: points.map((_, j) => rest.reduce((sum, i) => sum + rows[i]![j]!, 0)),
    });
  return cols;
}

/**
 * Stacked columns, one per day or period, each split by category (at most five named series and
 * "Other"). Read with arrow keys; the period you point at is read out in a band above the plot,
 * never over the bars. Has a legend and a "View as table" switch that shows the same figures.
 */
export function StackedBarChart({
  title,
  series,
  points,
  formatValue,
  formatTick = compactNumber,
  otherLabel,
  totalLabel,
  state,
  emptyLabels,
  droppedNote,
  height = 240,
  labels,
}: StackedBarChartProps) {
  const [boxRef, measured] = useWidth();
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const cols = stackSeries(series, points, otherLabel);
  const n = points.length;
  const totals = points.map((_, j) => cols.reduce((sum, c) => sum + c.values[j]!, 0));
  if (state !== undefined || n === 0 || !totals.some((t) => t > 0))
    return (
      <ChartEmpty message={chartStateMessage(state ?? 'empty', emptyLabels)} height={height} />
    );
  const dropped = series.reduce(
    (sum, s) => sum + points.filter((p) => isDropped(p.values[s.id])).length,
    0,
  );

  const width = measured > 0 ? measured : 640;
  const ticks = niceTicks(Math.max(...totals));
  const top = ticks[ticks.length - 1]!;
  const plotW = Math.max(width - AXIS_W - PAD.right, 1);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = plotW / n;
  const barW = Math.max(Math.min(slot * 0.68, 48), 1);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const xMid = (i: number) => AXIS_W + slot * (i + 0.5);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActive(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - rect.left - AXIS_W) / slot))));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? (dir === 1 ? -1 : n)) + dir)));
    } else if (e.key === 'Escape') setActive(null);
  };
  const xLabels = strideIndexes(n, slot, 64);
  const shown = active === null ? undefined : points[active];
  const readout = (j: number) =>
    `${points[j]!.label}: ${cols.map((c) => `${c.label} ${formatValue(c.values[j]!)}`).join(', ')}, ${totalLabel} ${formatValue(totals[j]!)}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ul className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-secondary">
          {cols.map((c) => (
            <li key={c.id} className="flex max-w-48 items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-3 shrink-0 rounded-sm ${colorClasses(c.colorKey).bg}`}
              />
              <span className="truncate" title={c.label}>
                {c.label}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          className="shrink-0 text-sm font-medium text-link underline"
        >
          {table ? labels.viewAsChart : labels.viewAsTable}
        </button>
      </div>
      <div id={tableId}>
        {table ? (
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-muted text-fg-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {labels.dateColumn}
                  </th>
                  {cols.map((c) => (
                    <th key={c.id} scope="col" className="px-3 py-2 text-end font-medium">
                      <span className="inline-flex max-w-40 items-center gap-2">
                        <span
                          aria-hidden="true"
                          data-swatch=""
                          className={`size-3 shrink-0 rounded-sm ${colorClasses(c.colorKey).bg}`}
                        />
                        <span className="truncate" title={c.label}>
                          {c.label}
                        </span>
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {totalLabel}
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, j) => (
                  <tr key={`${p.label}-${j}`} className="border-t border-line-row">
                    <th scope="row" className="px-3 py-2 text-start font-normal text-fg-secondary">
                      {p.label}
                    </th>
                    {cols.map((c) => (
                      <td key={c.id} className="px-3 py-2 text-end text-fg-secondary tabular-nums">
                        {formatValue(c.values[j]!)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-end font-medium text-fg tabular-nums">
                      {formatValue(totals[j]!)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div
              aria-hidden="true"
              data-stacked-tooltip=""
              className={`flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-1.5 text-xs text-fg-secondary ${active === null ? '' : 'bg-subtle'}`}
            >
              {shown === undefined || active === null ? (
                <span className="text-fg-muted">
                  {labels.readoutHint ?? 'Hover or focus a day for details'}
                </span>
              ) : (
                <>
                  <span className="font-semibold text-fg">{shown.label}</span>
                  {cols.map((c) => (
                    <span key={c.id} className="flex max-w-48 items-center gap-1.5">
                      <span
                        className={`size-2 shrink-0 rounded-sm ${colorClasses(c.colorKey).bg}`}
                      />
                      <span className="truncate" title={c.label}>
                        {c.label}
                      </span>
                      <span className="font-semibold text-fg tabular-nums">
                        {formatValue(c.values[active]!)}
                      </span>
                    </span>
                  ))}
                  <span className="ms-auto font-semibold text-fg tabular-nums">
                    {totalLabel} {formatValue(totals[active]!)}
                  </span>
                </>
              )}
            </div>
            <div ref={boxRef} className="relative w-full" style={{ height }}>
              <svg
                role="img"
                aria-label={title}
                tabIndex={0}
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                onPointerMove={pick}
                onPointerDown={pick}
                onPointerLeave={() => setActive(null)}
                onKeyDown={key}
                onBlur={() => setActive(null)}
                className="block overflow-visible outline-none focus-visible:outline-2 focus-visible:outline-focus"
                data-chart="stacked-bar"
              >
                {ticks.map((t) => (
                  <g key={t}>
                    <line
                      x1={AXIS_W}
                      x2={width - PAD.right}
                      y1={y(t)}
                      y2={y(t)}
                      className={t === 0 ? 'stroke-chart-axis' : 'stroke-chart-grid'}
                    />
                    <text
                      x={AXIS_W - 6}
                      y={y(t)}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize={12}
                      className="fill-fg-muted"
                    >
                      {formatTick(t)}
                    </text>
                  </g>
                ))}
                {xLabels.map((i) => (
                  <text
                    key={i}
                    x={xMid(i)}
                    y={height - 4}
                    fontSize={12}
                    textAnchor="middle"
                    className="fill-fg-muted"
                  >
                    {points[i]?.label}
                  </text>
                ))}
                {points.map((p, j) => {
                  let acc = 0;
                  return (
                    <g key={`${p.label}-${j}`} opacity={active === null || active === j ? 1 : 0.55}>
                      {cols.map((c) => {
                        const v = c.values[j]!;
                        if (v <= 0) return null;
                        const y1 = y(acc + v);
                        const h = y(acc) - y1;
                        acc += v;
                        return (
                          <rect
                            key={c.id}
                            x={xMid(j) - barW / 2}
                            y={y1}
                            width={barW}
                            height={Math.max(h - 1, 0.5)}
                            className={colorClasses(c.colorKey).fill}
                          />
                        );
                      })}
                    </g>
                  );
                })}
              </svg>
              <div role="status" className="sr-only">
                {active === null ? '' : readout(active)}
              </div>
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
