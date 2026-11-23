'use client';

import { useId, useState } from 'react';
import { ChartEmpty } from './chart-states.tsx';
import type { FunnelStep } from './bar-list.tsx';

export interface FunnelChartProps {
  /** The text alternative and the table caption ("Orders funnel, last 30 days"). */
  readonly title: string;
  readonly steps: readonly FunnelStep[];
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly stepColumn: string;
    readonly valueColumn: string;
    /** "From previous step" */
    readonly conversionColumn: string;
    /** Said when there are fewer than two steps or the first step is zero. */
    readonly notEnoughData: string;
  };
}

/** Whole-percent conversion of a step from the one before it; null when the base is zero. */
export function conversion(value: number, previous: number): number | null {
  return previous > 0 && Number.isFinite(value) ? Math.round((value / previous) * 100) : null;
}

/**
 * Funnel steps as bars on one scale (the first step is the whole), one hue that fades step by
 * step. Each later step prints its conversion from the step before it. "View as table" shows the
 * same figures as text; fewer than two steps, or an empty first step, says "not enough data".
 */
export function FunnelChart({ title, steps, labels }: FunnelChartProps) {
  const [table, setTable] = useState(false);
  const tableId = useId();
  const first = steps[0]?.value ?? 0;
  if (steps.length < 2 || !(first > 0))
    return <ChartEmpty message={labels.notEnoughData} height={160} />;
  const rows = steps.map((step, i) => ({
    step,
    share: Math.max(0, Math.min(100, (step.value / first) * 100)),
    conv: i === 0 ? null : conversion(step.value, steps[i - 1]!.value),
    opacity: 1 - (i / (steps.length - 1)) * 0.55,
  }));
  return (
    <div className="flex flex-col gap-3" data-chart="funnel">
      <div className="flex justify-end">
        <button
          type="button"
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          className="inline-flex min-h-11 items-center text-sm font-medium text-link underline sm:min-h-8"
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
                    {labels.stepColumn}
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {labels.valueColumn}
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {labels.conversionColumn}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ step, conv }) => (
                  <tr key={step.id} className="border-t border-line-row">
                    <th scope="row" className="px-3 py-2 text-start font-normal text-fg-secondary">
                      {step.label}
                    </th>
                    <td className="px-3 py-2 text-end text-fg">{step.display}</td>
                    <td className="px-3 py-2 text-end text-fg-secondary">
                      {conv === null ? '' : `${conv}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ol aria-label={title} className="flex flex-col gap-3">
            {rows.map(({ step, share, conv, opacity }) => (
              <li key={step.id} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 break-words text-fg">{step.label}</span>
                  <span className="shrink-0 font-medium text-fg">
                    {step.display}
                    {conv === null ? null : (
                      <span className="ms-2 text-xs font-normal text-fg-muted">{conv}%</span>
                    )}
                  </span>
                </span>
                <svg
                  aria-hidden="true"
                  focusable="false"
                  viewBox="0 0 100 10"
                  preserveAspectRatio="none"
                  className="block h-3 w-full overflow-hidden rounded-sm bg-chart-track"
                >
                  <rect
                    x={0}
                    y={0}
                    width={share}
                    height={10}
                    className="fill-chart-series"
                    opacity={opacity}
                  />
                </svg>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
