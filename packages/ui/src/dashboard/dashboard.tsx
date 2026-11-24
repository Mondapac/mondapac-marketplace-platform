import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { Sparkline } from './sparkline.tsx';
import { StatDelta, type StatDeltaProps } from './stat-delta.tsx';

export type StatTone = 'neutral' | 'attention' | 'critical' | 'info';

const TONE: Record<StatTone, string> = {
  neutral: 'text-fg',
  attention: 'text-attention-fg',
  critical: 'text-critical-fg',
  info: 'text-info-fg',
};

/**
 * The list the stat cards sit in: two columns on phones so the figures stay on the first screen,
 * then as many columns of 13rem or more as fit. Empty tracks stay empty, so a lone card keeps
 * the size of a card instead of stretching across the row.
 */
export function StatGrid({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]"
    >
      {children}
    </ul>
  );
}

export type GridSpan = 3 | 4 | 6 | 8 | 12;
/** Where an item sits when the grid is one column wide: KPIs first, the tasks card next, then the rest. */
export type MobileOrder = 'kpi' | 'tasks' | 'rest';

export interface GridLayout {
  /** Columns of 12 from the desktop width (lg) up. Default 12. */
  readonly span?: GridSpan;
  /** Columns of 12 at the tablet width (md). Default: the desktop span. */
  readonly tabletSpan?: GridSpan;
  /** Columns of 12 on a phone: 6 puts two items side by side (KPI cards). Default 12. */
  readonly phoneSpan?: 6 | 12;
  /** Phone order; from the tablet width the order is the order in the page. Default 'rest'. */
  readonly mobileOrder?: MobileOrder;
}

// Whole class names, so Tailwind finds them.
const LG_SPAN: Record<GridSpan, string> = {
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  6: 'lg:col-span-6',
  8: 'lg:col-span-8',
  12: 'lg:col-span-12',
};
const MD_SPAN: Record<GridSpan, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
  8: 'md:col-span-8',
  12: 'md:col-span-12',
};
const PHONE_SPAN: Record<6 | 12, string> = { 6: 'col-span-6', 12: 'col-span-12' };
const ORDER: Record<MobileOrder, string> = {
  kpi: 'order-1 md:order-none',
  tasks: 'order-2 md:order-none',
  rest: 'order-3 md:order-none',
};

/** The classes of one grid item (exported for tests and for items that are not a plain div). */
export function gridItemClass({
  span = 12,
  tabletSpan = span,
  phoneSpan = 12,
  mobileOrder = 'rest',
}: GridLayout = {}): string {
  return `min-w-0 ${PHONE_SPAN[phoneSpan]} ${MD_SPAN[tabletSpan]} ${LG_SPAN[span]} ${ORDER[mobileOrder]}`;
}

/**
 * The 12-column grid of a dashboard: one column on a phone (two for items with phoneSpan 6).
 * Known trade-off: the phone order is made with CSS `order`, so it changes what is seen, not the
 * DOM order that keyboard focus and screen readers follow (page order). Items are stretched to the
 * row's height so cards side by side match.
 */
export function DashboardGrid({
  className = '',
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-dashboard-grid=""
      className={`grid grid-cols-12 items-stretch gap-4 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

/**
 * One item of the grid; declares its spans and phone order. The item is a flex row (hidden while it has no content, so a card that turns out absent leaves no hole) so its child
 * fills it and matches the row's height: a child that is not a DashboardCard needs `flex-1`.
 */
export function GridItem({
  as: Tag = 'div',
  children,
  ...layout
}: GridLayout & { readonly as?: 'div' | 'li'; readonly children: ReactNode }) {
  return <Tag className={`flex empty:hidden ${gridItemClass(layout)}`}>{children}</Tag>;
}

export interface StatCardProps {
  readonly icon: IconName;
  /** What is counted ("Sellers awaiting review"). */
  readonly label: string;
  /** The figure, already formatted ("12", "25+", "A$1,204.50"). */
  readonly value: string;
  /** What the figure covers ("all sellers", "the first 50 held prices"). Always shown. */
  readonly scope: string;
  /** The page that lists what is counted. */
  readonly href: string;
  readonly tone?: StatTone;
  /** Shown instead of the figure when it could not be read; the card then does not link. */
  readonly error?: string;
  /** The change against the previous period. Its colour says better or worse, not up or down. */
  readonly delta?: StatDeltaProps;
  /** A small trend of the figure (values in time order); decoration, the figure is the text. */
  readonly sparkline?: readonly number[];
}

/**
 * One figure of a dashboard that links to the filtered list it counts. The scope line is part of
 * the card, so a number never stands without saying what it covers. A card whose read failed
 * says so in place and the rest of the dashboard still shows.
 */
export function StatCard({
  icon,
  label,
  value,
  scope,
  href,
  tone = 'neutral',
  error,
  delta,
  sparkline,
}: StatCardProps) {
  const body = (
    <>
      <span className="flex items-start gap-2 text-sm font-medium text-fg-secondary">
        <span className="flex h-5 items-center text-icon">
          <Icon name={icon} />
        </span>
        <span className="min-w-0 break-words sm:min-h-10">{label}</span>
      </span>
      {error === undefined ? (
        <span className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
          <span className={`text-2xl font-semibold sm:text-3xl ${TONE[tone]}`}>{value}</span>
          {sparkline === undefined ? null : <Sparkline values={sparkline} />}
        </span>
      ) : (
        <span role="alert" className="text-sm text-critical-fg">
          {error}
        </span>
      )}
      {delta === undefined || error !== undefined ? null : <StatDelta {...delta} />}
      <span className="text-xs text-fg-muted">{scope}</span>
    </>
  );
  const frame =
    'flex w-full min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-3 sm:gap-2 sm:p-4';
  return (
    <li className="flex">
      {error === undefined ? (
        <a href={href} className={`${frame} hover:bg-muted`}>
          {body}
        </a>
      ) : (
        <div className={frame}>{body}</div>
      )}
    </li>
  );
}

export interface DashboardCardProps {
  readonly id: string;
  readonly title: string;
  /** A "View all" link to the full page. */
  readonly action?: { readonly href: string; readonly label: string };
  /** A one-line note on what the card shows ("Latest 5 orders"). */
  readonly scope?: string;
  /** The card's read failed: this text replaces the body, the rest of the page is untouched. */
  readonly error?: string;
  /** The body is a table that fills the card's width (no padding of its own). */
  readonly flush?: boolean;
  /** Controls on the header's right, in the same row as the title (a view toggle). */
  readonly headerRight?: ReactNode;
  readonly children?: ReactNode;
}

/** A titled region of a dashboard (h2) with an optional link to the full page. */
export function DashboardCard({
  id,
  title,
  action,
  scope,
  error,
  flush = false,
  headerRight,
  children,
}: DashboardCardProps) {
  return (
    <section
      aria-labelledby={id}
      className="flex h-full min-w-0 flex-1 flex-col rounded-lg border border-line bg-surface"
    >
      <div className="flex items-baseline justify-between gap-x-4 px-4 pt-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={id} className="break-words text-lg font-semibold text-fg">
            {title}
          </h2>
          {scope === undefined ? null : <p className="text-xs text-fg-muted">{scope}</p>}
        </div>
        {headerRight === undefined || error !== undefined ? null : (
          <div className="shrink-0">{headerRight}</div>
        )}
        {action === undefined || error !== undefined ? null : (
          <a
            className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap text-sm font-medium text-link underline lg:min-h-0"
            href={action.href}
          >
            {action.label}
          </a>
        )}
      </div>
      <div className={`flex flex-1 flex-col ${flush && error === undefined ? 'pt-3' : 'p-4'}`}>
        {error === undefined ? (
          children
        ) : (
          <p role="alert" className="text-sm text-critical-fg">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export interface DistributionPart {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly tone: 'success' | 'attention' | 'info' | 'critical' | 'neutral';
}

const FILL: Record<DistributionPart['tone'], string> = {
  success: 'fill-success-fg',
  attention: 'fill-attention-fg',
  info: 'fill-info-fg',
  critical: 'fill-critical-fg',
  neutral: 'fill-neutral-fg',
};
/** The legend dot of each tone; the chart's skeleton uses the same. */
export const SWATCH: Record<DistributionPart['tone'], string> = {
  success: 'bg-success-fg',
  attention: 'bg-attention-fg',
  info: 'bg-info-fg',
  critical: 'bg-critical-fg',
  neutral: 'bg-neutral-fg',
};

/**
 * One stacked bar drawn as plain SVG from tokens, with the legend under it. The legend lists
 * every part with its figure, so it is also the text alternative: the bar itself is decoration.
 * Parts with a zero value stay in the legend and take no width.
 */
export function DistributionBar({
  parts,
  emptyLabel,
}: {
  readonly parts: readonly DistributionPart[];
  /** Said when every part is zero. */
  readonly emptyLabel: string;
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  let offset = 0;
  return (
    <div className="flex flex-col gap-3">
      {total === 0 ? (
        <p className="text-sm text-fg-muted">{emptyLabel}</p>
      ) : (
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 100 4"
          preserveAspectRatio="none"
          className="h-3 w-full overflow-hidden rounded-full bg-muted"
        >
          {parts.map((part) => {
            const width = (part.value / total) * 100;
            const x = offset;
            offset += width;
            return width === 0 ? null : (
              <rect
                key={part.id}
                x={x}
                y={0}
                width={width}
                height={4}
                className={FILL[part.tone]}
              />
            );
          })}
        </svg>
      )}
      <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {parts.map((part) => (
          <li key={part.id} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-2.5 shrink-0 rounded-full ${SWATCH[part.tone]}`}
              />
              <span className="min-w-0 break-words text-fg-secondary">{part.label}</span>
            </span>
            <span className="font-medium text-fg">{part.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
