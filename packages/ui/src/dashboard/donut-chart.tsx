'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { categoryClasses, CATEGORY_MAX } from './chart-palette.ts';
import { splitTop } from './chart-scale.ts';
import { ChartEmpty } from './chart-states.tsx';

export interface DonutSegment {
  readonly id: string;
  readonly label: string;
  readonly value: number;
}

export interface DonutChartProps {
  /** The text alternative and the table caption ("Sales by category, last 30 days"). */
  readonly title: string;
  readonly segments: readonly DonutSegment[];
  /** Formats a value for the legend, the tooltip and the table ("A$1,204"). */
  readonly formatValue: (value: number) => string;
  /** Formats a share (0 to 1); defaults to a whole or one-decimal percent. */
  readonly formatShare?: (share: number) => string;
  /** The label of the bucket that holds everything past the fifth category ("Other"). */
  readonly otherLabel: string;
  /** The word under the total in the centre ("Total"). */
  readonly totalLabel: string;
  /** Said in place of the chart when there is nothing to show ("Not enough data for this period"). */
  readonly emptyMessage: string;
  readonly size?: number;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly categoryColumn: string;
    readonly valueColumn: string;
    readonly shareColumn: string;
  };
}

interface Slice {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly share: number;
  /** The palette position; -1 for "Other". */
  readonly color: number;
}

const defaultShare = (share: number) => {
  const p = share * 100;
  return `${Number.isInteger(Math.round(p * 10) / 10) ? Math.round(p) : (Math.round(p * 10) / 10).toFixed(1)}%`;
};

/** Up to five named slices by size, then everything else as one "Other" slice. */
export function sliceSegments(segments: readonly DonutSegment[], otherLabel: string): Slice[] {
  const { top, rest } = splitTop(
    segments.map((s) => s.value),
    CATEGORY_MAX,
  );
  const total = [...top, ...rest].reduce((sum, i) => sum + segments[i]!.value, 0);
  if (total <= 0) return [];
  const named = top.map((i, k) => ({
    id: segments[i]!.id,
    label: segments[i]!.label,
    value: segments[i]!.value,
    share: segments[i]!.value / total,
    color: k,
  }));
  if (rest.length === 0) return named;
  const other = rest.reduce((sum, i) => sum + segments[i]!.value, 0);
  return [
    ...named,
    { id: '__other', label: otherLabel, value: other, share: other / total, color: -1 },
  ];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const pt = (a: number) =>
    `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${pt(from)} A${r} ${r} 0 ${to - from > Math.PI ? 1 : 0} 1 ${pt(to)}`;
}

/**
 * A donut of one total split into at most five named categories and an "Other" bucket, in the
 * categorical palette. Every figure is also printed in the legend, each segment can be focused
 * (Tab, then arrow keys) to read it, and "View as table" shows the same figures as text.
 */
export function DonutChart({
  title,
  segments,
  formatValue,
  formatShare = defaultShare,
  otherLabel,
  totalLabel,
  emptyMessage,
  size = 176,
  labels,
}: DonutChartProps) {
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const slices = sliceSegments(segments, otherLabel);
  if (slices.length === 0) return <ChartEmpty message={emptyMessage} height={size} />;

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const thickness = Math.round(size * 0.14);
  const r = (size - thickness) / 2 - 1;
  const c = size / 2;
  const gap = slices.length > 1 ? 0.035 : 0;
  let cursor = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const from = cursor;
    cursor += s.share * Math.PI * 2;
    return { from, to: cursor };
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
  const mid = active === null ? 0 : (arcs[active]!.from + arcs[active]!.to) / 2;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
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
                    <th scope="row" className="px-3 py-2 text-start font-normal text-fg-secondary">
                      {s.label}
                    </th>
                    <td className="px-3 py-2 text-end text-fg">{formatValue(s.value)}</td>
                    <td className="px-3 py-2 text-end text-fg-secondary">{formatShare(s.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                  const from = a.from + gap / 2;
                  const to = Math.max(from + 0.001, a.to - gap / 2);
                  const cls = categoryClasses(s.color);
                  const label = `${s.label}: ${formatValue(s.value)}, ${formatShare(s.share)}`;
                  const full = s.share > 0.9999;
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
                      {full ? (
                        <circle
                          cx={c}
                          cy={c}
                          r={r}
                          fill="none"
                          strokeWidth={thickness + (active === i ? 4 : 0)}
                          className={cls.stroke}
                        />
                      ) : (
                        <path
                          d={arc(c, c, r, from, to)}
                          fill="none"
                          strokeWidth={thickness + (active === i ? 4 : 0)}
                          className={cls.stroke}
                        />
                      )}
                    </g>
                  );
                })}
                {active === null || arcs[active] === undefined ? null : (
                  <path
                    aria-hidden="true"
                    d={arc(
                      c,
                      c,
                      r + thickness / 2 + 5,
                      arcs[active].from + gap / 2,
                      Math.max(arcs[active].from + gap / 2 + 0.001, arcs[active].to - gap / 2),
                    )}
                    fill="none"
                    strokeWidth={2}
                    className="stroke-focus"
                  />
                )}
                <text
                  x={c}
                  y={c - 2}
                  textAnchor="middle"
                  fontSize={size >= 160 ? 18 : 15}
                  fontWeight={600}
                  className="fill-fg"
                >
                  {formatValue(total)}
                </text>
                <text x={c} y={c + 16} textAnchor="middle" fontSize={12} className="fill-fg-muted">
                  {totalLabel}
                </text>
              </svg>
              <div role="status" className="sr-only">
                {shown === undefined
                  ? ''
                  : `${shown.label}: ${formatValue(shown.value)}, ${formatShare(shown.share)}`}
              </div>
              {shown === undefined ? null : (
                <div
                  aria-hidden="true"
                  data-donut-tooltip=""
                  className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-chart-tooltip px-2.5 py-1.5 text-xs text-chart-tooltip-fg shadow"
                  style={{ left: '50%', top: -6, transform: 'translate(-50%, -100%)' }}
                >
                  <div className="text-chart-tooltip-muted">{shown.label}</div>
                  <div className="font-semibold">
                    {formatValue(shown.value)} · {formatShare(shown.share)}
                  </div>
                </div>
              )}
            </div>
            <ul className="flex min-w-48 flex-col gap-2 text-sm">
              {slices.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`size-3 shrink-0 rounded-sm ${categoryClasses(s.color).bg}`}
                  />
                  <span className="min-w-0 flex-1 break-words text-fg-secondary">{s.label}</span>
                  <span className="font-medium text-fg">{formatValue(s.value)}</span>
                  <span className="w-12 text-end text-fg-muted">{formatShare(s.share)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
