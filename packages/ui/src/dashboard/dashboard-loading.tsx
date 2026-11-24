'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { CARD_TABLE } from '../data/card-table.ts';
import { Icon, type IconName } from '../icon/icon.tsx';
import { useDelayedLoading, type DelayedLoading } from '../loading/use-delayed-loading.ts';
import type { ActivitySkeletonColumn } from './activity-skeleton-columns.ts';
import { DashboardCard, SWATCH, type DistributionPart } from './dashboard.tsx';

type Register = () => () => void;

const LoadingCount = createContext<Register | null>(null);

/**
 * Panel loading L4: the frame of a dashboard whose cards load one by one. While any card still
 * shows its skeleton the content is aria-busy and one role="status" says the page's label
 * ("Loading the dashboard"), so a screen reader hears it once, not once per card.
 */
export function DashboardLoading({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [count, setCount] = useState(0);
  const [register] = useState<Register>(() => () => {
    setCount((value) => value + 1);
    return () => setCount((value) => value - 1);
  });
  return (
    <LoadingCount.Provider value={register}>
      <div aria-busy={count > 0} className={className}>
        <span role="status" className="sr-only">
          {count > 0 ? label : ''}
        </span>
        {children}
      </div>
    </LoadingCount.Provider>
  );
}

/** A card skeleton: counted by the page's status while it is mounted, and timed (200 ms, 10 s, 30 s). */
function useCardLoading(): DelayedLoading {
  const register = useContext(LoadingCount);
  useEffect(() => register?.(), [register]);
  return useDelayedLoading(true);
}

/** A bar inside a line box of the real text's height, so a row keeps its height with or without bars. */
function Bar({
  visible,
  line = 'h-5',
  className,
}: {
  readonly visible: boolean;
  readonly line?: string;
  readonly className: string;
}) {
  return (
    <span className={`flex ${line} items-center`}>
      {visible ? <span className={`max-w-full rounded-sm bg-muted ${className}`} /> : null}
    </span>
  );
}

export interface StatCardSkeletonProps {
  readonly icon: IconName;
  /** The card's real label: it is known before the figure is. */
  readonly label: string;
  /** Shown in place of the figure after 30 s, like a figure whose read failed. */
  readonly stalledLabel: string;
  /** The element it is: a list item in a StatGrid (default), a plain div as a KpiCard's twin. */
  readonly as?: 'li' | 'div';
}

/**
 * The placeholder of one StatCard: the same frame, icon and label, with bars for the figure and
 * its scope line. Nothing but the frame and label shows for the first 200 ms.
 */
export function StatCardSkeleton({
  icon,
  label,
  stalledLabel,
  as: Tag = 'li',
}: StatCardSkeletonProps) {
  const loading = useCardLoading();
  const bars = loading.visible && !loading.stalled;
  return (
    <Tag className="flex w-full" data-skeleton="stat">
      <div className="flex w-full min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-3 sm:gap-2 sm:p-4">
        <span className="flex items-start gap-2 text-sm font-medium text-fg-secondary">
          <span className="flex h-5 items-center text-icon">
            <Icon name={icon} />
          </span>
          <span className="min-w-0 break-words sm:min-h-10">{label}</span>
        </span>
        {loading.stalled ? (
          <span role="alert" className="text-sm text-critical-fg">
            {stalledLabel}
          </span>
        ) : (
          <span aria-hidden="true" className="block motion-safe:animate-pulse">
            {/* The line boxes of text-2xl and, from 640 px, text-3xl. */}
            <Bar visible={bars} line="h-8 sm:h-9" className="h-6 w-12 sm:h-7" />
          </span>
        )}
        <span aria-hidden="true" className="block motion-safe:animate-pulse">
          <Bar visible={bars} line="h-4" className="h-3 w-28" />
        </span>
      </div>
    </Tag>
  );
}

// The same column widths as ActivityTable, so the header does not move when the rows arrive.
const SIZE = {
  status: 'w-44',
  text: 'w-44',
  figure: 'w-40',
  date: 'w-40',
  'zoned-date': 'w-48',
} as const;
const TITLE_WIDTHS = ['w-48', 'w-40', 'w-56', 'w-36', 'w-44'] as const;
const VALUE_WIDTH = {
  status: 'w-20',
  text: 'w-24',
  figure: 'w-16',
  date: 'w-28',
  'zoned-date': 'w-36',
} as const;

interface CardFrameProps {
  readonly id: string;
  readonly title: string;
  readonly scope?: string;
  readonly action?: { readonly href: string; readonly label: string };
  /** "Still loading…", shown under the bars after 10 s. */
  readonly slowLabel: string;
  /** Shown in place of the body after 30 s, like a card whose read failed. */
  readonly stalledLabel: string;
}

export interface ActivityCardSkeletonProps extends CardFrameProps {
  /** The columns of the card's table, with their real headers (see `activitySkeletonColumns`). */
  readonly columns: readonly ActivitySkeletonColumn[];
  /** Rows the card lists when full. */
  readonly rows: number;
  /** Lines of the title cell (a name and a muted line under it). */
  readonly titleLines?: number;
}

/**
 * The placeholder of a DashboardCard holding an ActivityTable: the real title, scope, link and
 * column headers, and bar rows laid out like the table (a table from 1024 px, labelled cards
 * below with the real labels). The rows keep their height before the bars show, so the card
 * never grows when they do.
 */
export function ActivityCardSkeleton({
  id,
  title,
  scope,
  action,
  columns,
  rows,
  titleLines = 1,
  slowLabel,
  stalledLabel,
}: ActivityCardSkeletonProps) {
  const loading = useCardLoading();
  const frame = { id, title, ...(scope === undefined ? {} : { scope }) };
  if (loading.stalled) return <DashboardCard {...frame} error={stalledLabel} />;
  const bars = loading.visible;
  return (
    <DashboardCard {...frame} {...(action === undefined ? {} : { action })} flush>
      <div data-skeleton="activity">
        <table aria-hidden="true" className={`${CARD_TABLE.table} lg:table-fixed`}>
          <colgroup className="max-lg:hidden">
            {columns.map((column) => (
              <col
                key={column.id}
                className={column.size === undefined ? undefined : SIZE[column.size]}
              />
            ))}
          </colgroup>
          <thead className={CARD_TABLE.head}>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={`px-4 py-3 font-medium ${column.align === 'end' ? 'text-end' : ''}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className={`${CARD_TABLE.body} border-t border-line-row motion-safe:animate-pulse`}
          >
            {Array.from({ length: rows }, (_, row) => (
              <tr key={row} className={CARD_TABLE.row}>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    data-label={column.kind === 'labelled' ? column.header : undefined}
                    className={CARD_TABLE[column.kind === 'title' ? 'cell' : column.kind]}
                  >
                    {column.kind === 'title' ? (
                      Array.from({ length: titleLines }, (_, line) => (
                        <Bar
                          key={line}
                          visible={bars}
                          className={
                            line === 0
                              ? `h-3.5 ${TITLE_WIDTHS[row % TITLE_WIDTHS.length]}`
                              : 'h-3 w-24'
                          }
                        />
                      ))
                    ) : column.kind === 'corner' ? (
                      <Bar visible={bars} className="h-5 w-20 rounded-full" />
                    ) : (
                      <span className={`flex ${column.align === 'end' ? 'lg:justify-end' : ''}`}>
                        <Bar
                          visible={bars}
                          className={`h-3.5 ${VALUE_WIDTH[column.size ?? 'text']}`}
                        />
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading.slow ? <p className="px-4 pb-4 text-sm text-fg-muted">{slowLabel}</p> : null}
      </div>
    </DashboardCard>
  );
}

export interface DistributionCardSkeletonProps extends CardFrameProps {
  /** The parts of the chart, with their real labels and colours; only the figures are bars. */
  readonly parts: readonly Omit<DistributionPart, 'value'>[];
}

/** The placeholder of a DashboardCard holding a DistributionBar: a grey bar and the real legend. */
export function DistributionCardSkeleton({
  id,
  title,
  scope,
  action,
  parts,
  slowLabel,
  stalledLabel,
}: DistributionCardSkeletonProps) {
  const loading = useCardLoading();
  const frame = { id, title, ...(scope === undefined ? {} : { scope }) };
  if (loading.stalled) return <DashboardCard {...frame} error={stalledLabel} />;
  const bars = loading.visible;
  return (
    <DashboardCard {...frame} {...(action === undefined ? {} : { action })}>
      <div data-skeleton="distribution" className="flex flex-col gap-3">
        <div aria-hidden="true" className="flex flex-col gap-3 motion-safe:animate-pulse">
          <span className={`h-3 w-full rounded-full ${bars ? 'bg-muted' : ''}`} />
          <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {parts.map((part) => (
              <li key={part.id} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`size-2.5 shrink-0 rounded-full ${SWATCH[part.tone]}`} />
                  <span className="min-w-0 break-words text-fg-secondary">{part.label}</span>
                </span>
                <Bar visible={bars} className="h-3.5 w-6" />
              </li>
            ))}
          </ul>
        </div>
        {loading.slow ? <p className="text-sm text-fg-muted">{slowLabel}</p> : null}
      </div>
    </DashboardCard>
  );
}

export interface ChartCardSkeletonProps extends CardFrameProps {
  /** The height of the chart the card shows when full. */
  readonly height?: number;
}

/**
 * The placeholder of a DashboardCard holding a chart: the real title, scope and link, and grid
 * lines at the chart's height. Counted by the page's status like every card skeleton.
 */
export function ChartCardSkeleton({
  id,
  title,
  scope,
  action,
  height = 240,
  slowLabel,
  stalledLabel,
}: ChartCardSkeletonProps) {
  const loading = useCardLoading();
  const frame = { id, title, ...(scope === undefined ? {} : { scope }) };
  if (loading.stalled) return <DashboardCard {...frame} error={stalledLabel} />;
  return (
    <DashboardCard {...frame} {...(action === undefined ? {} : { action })}>
      <div data-skeleton="chart-card">
        <div
          aria-hidden="true"
          style={{ height }}
          className="flex flex-col justify-between motion-safe:animate-pulse"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="block h-px w-full bg-muted" />
          ))}
        </div>
        {loading.slow ? <p className="mt-2 text-xs text-fg-muted">{slowLabel}</p> : null}
      </div>
    </DashboardCard>
  );
}
