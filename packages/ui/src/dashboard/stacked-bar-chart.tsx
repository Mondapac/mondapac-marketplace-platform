'use client';

import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { categoryClasses, CATEGORY_MAX } from './chart-palette.ts';
import { compactNumber, labelIndexes, niceTicks, splitTop } from './chart-scale.ts';
import { ChartEmpty } from './chart-states.tsx';
import { useWidth } from './use-width.ts';

export interface StackedSeries {
  readonly id: string;
  readonly label: string;
}

export interface StackedPoint {
  /** The x label as shown ("12 Nov"). */
  readonly label: string;
  /** The value of each series for this period, by series id; a missing id counts as 0. */
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
  readonly emptyMessage: string;
  readonly height?: number;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly dateColumn: string;
  };
}

const AXIS_W = 52;
const PAD = { top: 8, right: 8, bottom: 22 };

interface Column {
  readonly id: string;
  readonly label: string;
  /** The palette position; -1 for "Other". */
  readonly color: number;
  readonly values: readonly number[];
}

const clean = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 0);

/** Up to five named series by their total over all periods, the rest summed into "Other". */
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
  const cols: Column[] = top.map((i, k) => ({
    id: series[i]!.id,
    label: series[i]!.label,
    color: k,
    values: rows[i]!,
  }));
  if (rest.length > 0)
    cols.push({
      id: '__other',
      label: otherLabel,
      color: -1,
      values: points.map((_, j) => rest.reduce((sum, i) => sum + rows[i]![j]!, 0)),
    });
  return cols;
}

/**
 * Stacked columns, one per day or period, each split by category in the categorical palette (at
 * most five named categories and "Other"). Read with arrow keys, with a legend, a tooltip and a
 * "View as table" switch that shows the same figures as text.
 */
export function StackedBarChart({
  title,
  series,
  points,
  formatValue,
  formatTick = compactNumber,
  otherLabel,
  totalLabel,
  emptyMessage,
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
  if (n === 0 || !totals.some((t) => t > 0))
    return <ChartEmpty message={emptyMessage} height={height} />;

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
  const xLabels = labelIndexes(n, Math.max(2, Math.floor(plotW / 90)));
  const shown = active === null ? undefined : points[active];
  const readout = (j: number) =>
    `${points[j]!.label}: ${cols.map((c) => `${c.label} ${formatValue(c.values[j]!)}`).join(', ')}, ${totalLabel} ${formatValue(totals[j]!)}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-secondary">
          {cols.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-3 rounded-sm ${categoryClasses(c.color).bg}`}
              />
              {c.label}
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          className="text-sm font-medium text-link underline"
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
                      {c.label}
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
                      <td key={c.id} className="px-3 py-2 text-end text-fg-secondary">
                        {formatValue(c.values[j]!)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-end font-medium text-fg">
                      {formatValue(totals[j]!)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
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
                          className={categoryClasses(c.color).fill}
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
            {active === null || shown === undefined ? null : (
              <div
                aria-hidden="true"
                data-stacked-tooltip=""
                className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md bg-chart-tooltip px-2.5 py-1.5 text-xs text-chart-tooltip-fg shadow"
                style={{
                  left: Math.min(Math.max(xMid(active), 80), Math.max(width - 80, 80)),
                  transform: 'translateX(-50%)',
                }}
              >
                <div className="text-chart-tooltip-muted">{shown.label}</div>
                {cols.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 rounded-sm ${categoryClasses(c.color).bg}`}
                    />
                    <span className="text-chart-tooltip-muted">{c.label}</span>
                    <span className="ms-auto ps-3 font-semibold">
                      {formatValue(c.values[active]!)}
                    </span>
                  </div>
                ))}
                <div className="mt-1 flex border-t border-chart-tooltip-muted/40 pt-1 font-semibold">
                  <span className="text-chart-tooltip-muted">{totalLabel}</span>
                  <span className="ms-auto ps-3">{formatValue(totals[active]!)}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
