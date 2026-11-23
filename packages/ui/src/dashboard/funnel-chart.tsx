'use client';

import { useId, useState, type ReactNode } from 'react';
import type { FunnelStep } from './bar-list.tsx';
import { ChartEmpty } from './chart-states.tsx';
import { DashboardCard, type DashboardCardProps } from './dashboard.tsx';

export interface FunnelChartLabels {
  readonly viewAsTable: string;
  readonly viewAsChart: string;
  readonly stepColumn: string;
  readonly valueColumn: string;
  /** "From previous step": the column header and the screen-reader text of each percentage. */
  readonly conversionColumn: string;
  /** Said when there are fewer than two steps. */
  readonly notEnoughData: string;
  /** Said when the first step is zero ("No orders in this period"). */
  readonly empty: string;
  /** An optional line under `empty` ("Orders appear here once customers check out"). */
  readonly emptyHint?: string;
}

export interface FunnelChartProps {
  /** The text alternative and the table caption ("Orders funnel, last 30 days"). */
  readonly title: string;
  readonly steps: readonly FunnelStep[];
  readonly labels: FunnelChartLabels;
  /**
   * Controlled view: the host keeps the state and renders `FunnelViewToggle` in the card header
   * (see `FunnelChartCard`); without it the chart keeps its own toggle above the bars.
   */
  readonly view?: 'chart' | 'table';
  /** Id of the element the header toggle controls; set by the card that hosts the toggle. */
  readonly panelId?: string;
}

const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Conversion of a step from the one before it, in percent (unrounded); null when the base is zero. */
export function conversion(value: number, previous: number): number | null {
  const base = safe(previous);
  return base > 0 ? (safe(value) / base) * 100 : null;
}

/** "75%", "<1%", or "—" when there is no base. A step above its predecessor shows its true share. */
export function formatConversion(value: number, previous: number): string {
  const pct = conversion(value, previous);
  if (pct === null) return '—';
  if (pct > 0 && pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

/** The "View as table" / "View as chart" switch; `pressed` is true while the table shows. */
export function FunnelViewToggle({
  pressed,
  onToggle,
  controls,
  labels,
}: {
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly controls: string;
  readonly labels: Pick<FunnelChartLabels, 'viewAsTable' | 'viewAsChart'>;
}) {
  return (
    <button
      type="button"
      aria-controls={controls}
      aria-pressed={pressed}
      onClick={onToggle}
      className="inline-flex min-h-11 items-center text-sm font-medium text-link underline lg:min-h-8"
    >
      {pressed ? labels.viewAsChart : labels.viewAsTable}
    </button>
  );
}

/**
 * Funnel steps as bars on one scale (the first step is the whole), one hue that fades step by
 * step (never below 65% so every bar stays visible). Each later step prints its conversion from
 * the step before it; the first step shows "—". A step larger than the one before prints its true
 * share (it is a data error worth seeing) and only its bar is capped at the full width. "View as
 * table" shows the same figures as text. Fewer than two steps says "not enough data"; an empty
 * first step says `labels.empty`.
 */
export function FunnelChart({ title, steps, labels, view, panelId }: FunnelChartProps) {
  const [own, setOwn] = useState<'chart' | 'table'>('chart');
  const ownId = useId();
  const controlled = view !== undefined;
  const current = controlled ? view : own;
  const id = panelId ?? ownId;
  const first = safe(steps[0]?.value ?? 0);
  if (steps.length < 2) return <ChartEmpty message={labels.notEnoughData} height={160} />;
  if (!(first > 0)) {
    return (
      <ChartEmpty
        message={labels.empty}
        height={160}
        {...(labels.emptyHint === undefined ? {} : { hint: labels.emptyHint })}
      />
    );
  }
  const rows = steps.map((step, i) => ({
    step,
    share: Math.min(100, (safe(step.value) / first) * 100),
    conv: i === 0 ? '—' : formatConversion(step.value, steps[i - 1]!.value),
    opacity: 1 - (i / (steps.length - 1)) * 0.35,
  }));
  const toggle: ReactNode = controlled ? null : (
    <div className="flex justify-end">
      <FunnelViewToggle
        pressed={current === 'table'}
        onToggle={() => setOwn(current === 'table' ? 'chart' : 'table')}
        controls={id}
        labels={labels}
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-chart="funnel">
      {toggle}
      <div id={id}>
        {current === 'table' ? (
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
                    <td className="px-3 py-2 text-end text-fg-secondary">{conv}</td>
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
                    <span className="ms-2 text-xs font-normal text-fg-muted">
                      <span className="sr-only">{labels.conversionColumn}: </span>
                      {conv}
                    </span>
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="block h-3 w-full overflow-hidden rounded-full bg-chart-track"
                >
                  <span
                    data-funnel="fill"
                    className="block h-full rounded-full bg-chart-series"
                    style={{ width: `${share}%`, opacity }}
                  />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** A card around a funnel with the view toggle in the card header (no extra row). */
export function FunnelChartCard({
  steps,
  labels,
  title,
  ...card
}: Omit<DashboardCardProps, 'children' | 'headerRight' | 'flush'> &
  Pick<FunnelChartProps, 'steps' | 'labels'>) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const panelId = useId();
  const usable = steps.length >= 2 && (steps[0]?.value ?? 0) > 0;
  return (
    <DashboardCard
      {...card}
      title={title}
      {...(usable
        ? {
            headerRight: (
              <FunnelViewToggle
                pressed={view === 'table'}
                onToggle={() => setView(view === 'table' ? 'chart' : 'table')}
                controls={panelId}
                labels={labels}
              />
            ),
          }
        : {})}
    >
      <FunnelChart title={title} steps={steps} labels={labels} view={view} panelId={panelId} />
    </DashboardCard>
  );
}
