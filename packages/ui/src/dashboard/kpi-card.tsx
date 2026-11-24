'use client';

import { useId, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon.tsx';
import { Sparkline } from './sparkline.tsx';
import { StatDelta, type StatDeltaProps } from './stat-delta.tsx';

/** The colour of a KPI card's icon tile (tokens kpi-blue, kpi-aqua, kpi-violet and kpi-slate). */
export type KpiTile = 'blue' | 'aqua' | 'violet' | 'slate';

// Whole class names, so Tailwind finds them.
const TILE: Record<KpiTile, string> = {
  blue: 'bg-kpi-blue-bg text-kpi-blue-fg',
  aqua: 'bg-kpi-aqua-bg text-kpi-aqua-fg',
  violet: 'bg-kpi-violet-bg text-kpi-violet-fg',
  slate: 'bg-kpi-slate-bg text-kpi-slate-fg',
};

export interface KpiCardProps {
  readonly icon: IconName;
  readonly tile: KpiTile;
  /** What is shown ("Sales (incl. GST)"). */
  readonly label: string;
  /** What the figure means, read from the "?" button ("Goods of paid orders with GST..."). */
  readonly definition: string;
  /** Names the "?" button ("What is Net earnings?"). */
  readonly definitionLabel: string;
  /** The figure as shown. Not used with `note` or `error`. */
  readonly value?: string;
  /**
   * Said instead of a figure when there is none to show ("Available after a week of payout
   * records"). A withheld figure is never drawn as a number, a zero or a partial total.
   */
  readonly note?: string;
  /** Shown instead of the figure when it could not be read. */
  readonly error?: string;
  /** What the figure covers ("Last 30 days"). Always shown. */
  readonly scope: string;
  /** The page that lists what is counted; the label is then the link of the whole card. */
  readonly href?: string;
  /** Only one card of a strip is highlighted (the main figure). */
  readonly highlight?: boolean;
  readonly delta?: StatDeltaProps;
  /** A small trend (values in time order); decoration, the figure is the text. */
  readonly sparkline?: readonly number[];
  /** A small status next to the change line ("Scheduled"). */
  readonly badge?: ReactNode;
}

/**
 * One headline figure of a dashboard: a coloured icon tile, the label with a "?" definition,
 * the figure, its change against the previous period and what it covers. White; the one
 * `highlight` card gets a blue tint. A figure that is not available says so in words.
 */
export function KpiCard({
  icon,
  tile,
  label,
  definition,
  definitionLabel,
  value,
  note,
  error,
  scope,
  href,
  highlight = false,
  delta,
  sparkline,
  badge,
}: KpiCardProps) {
  const [open, setOpen] = useState(false);
  const definitionId = useId();
  const withheld = error === undefined && value === undefined;
  return (
    <div
      data-kpi-card=""
      {...(highlight ? { 'data-highlight': '' } : {})}
      className={`relative flex h-full w-full min-w-0 flex-col gap-1 rounded-lg border p-3 sm:gap-2 sm:p-4 ${
        highlight ? 'border-info-border bg-info-bg' : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-sm font-medium text-fg-secondary">
          {href === undefined || error !== undefined ? (
            <span className="min-w-0 break-words">{label}</span>
          ) : (
            <a
              href={href}
              className="min-w-0 break-words after:absolute after:inset-0 after:rounded-lg hover:underline"
            >
              {label}
            </a>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={definitionId}
            aria-label={definitionLabel}
            onClick={() => setOpen((v) => !v)}
            className="relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-icon-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus lg:size-5"
          >
            <Icon name="help" />
          </button>
        </span>
        <span
          aria-hidden="true"
          className={`flex size-8 shrink-0 items-center justify-center rounded-md ${TILE[tile]}`}
        >
          <Icon name={icon} />
        </span>
      </div>
      {open ? (
        <p id={definitionId} className="text-xs text-fg-secondary">
          {definition}
        </p>
      ) : null}
      {error !== undefined ? (
        <span role="alert" className="text-sm text-critical-fg">
          {error}
        </span>
      ) : withheld ? (
        <span className="text-sm text-fg-muted">{note}</span>
      ) : (
        <span className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
          <span className="text-2xl font-semibold tabular-nums text-fg sm:text-3xl">{value}</span>
          {sparkline === undefined ? null : <Sparkline values={sparkline} />}
        </span>
      )}
      {error !== undefined || (delta === undefined && badge === undefined) ? null : (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {badge}
          {delta === undefined ? null : <StatDelta {...delta} />}
        </span>
      )}
      <span className="text-xs text-fg-muted">{scope}</span>
    </div>
  );
}
