'use client';

import type { ReactNode } from 'react';
import { Icon } from '../icon/icon.tsx';
import { useDesktop } from '../list/use-desktop.ts';
import { DashboardCard } from './dashboard.tsx';
import {
  foldRows,
  groupWorkQueue,
  shortAge,
  workQueueStatus,
  workQueueTone,
  type WorkQueueLevel,
  type WorkQueueRow,
  type WorkQueueStatus,
  type WorkQueueTone,
} from './work-queue.ts';

/** The words of the card; the panel owns them (English, LTR) and the card only places them. */
export interface WorkQueueCardLabels {
  readonly title: string;
  /** One line under the title on what the card shows and how fresh it is. */
  readonly scope: string;
  /** "Critical · 4 queues", "Today · top 5 of 9 queues", "Review queues". */
  readonly group: (level: WorkQueueLevel, shown: number, total: number) => string;
  /** "17", "17 · 5 overdue". */
  readonly count: (count: number, overdue: number) => string;
  /** The status words of a row; `age` is already short ("3h"). */
  readonly status: (status: WorkQueueStatus, age: string | null, row: WorkQueueRow) => string;
  /** The folded line of the other today queues: "4 more queues". */
  readonly todayMore: (queues: number) => string;
  /** The folded review line: "Reports, certificates and 6 more". */
  readonly reviewLine: (names: readonly string[], more: number) => string;
  /** "Oldest 6d" on a folded line. */
  readonly oldest: (age: string) => string;
  /** "3 queues all clear". */
  readonly clear: (queues: number) => string;
  /** Nothing anywhere needs action. */
  readonly allClear: string;
  /** A folded line holds a queue that could not be read. */
  readonly someFailed: string;
}

export interface WorkQueueCardProps {
  readonly id: string;
  readonly rows: readonly WorkQueueRow[];
  readonly labels: WorkQueueCardLabels;
  readonly locale: string;
  /** The instant the ages are measured from (the answer's `generatedAt`, or now). */
  readonly now: number;
  /** "Open work queue (38)": the full page of every queue; the folded lines link there too. */
  readonly open?: { readonly href: string; readonly label: string };
  /** The full page opened on one level (the folded lines); without it they do not link. */
  readonly levelHref?: (level: WorkQueueLevel) => string;
  /** How many today queues show before the rest fold (design section 2: 5). */
  readonly todayLimit?: number;
}

const DOT: Record<WorkQueueTone, string> = {
  critical: 'bg-critical-fg',
  attention: 'bg-attention-fg',
  neutral: 'bg-fg-muted',
};

const TEXT: Record<WorkQueueTone, string> = {
  critical: 'text-critical-fg',
  attention: 'text-attention-fg',
  neutral: 'text-fg-muted',
};

function Label({ href, children }: { readonly href: string | null; readonly children: ReactNode }) {
  return href === null ? (
    <span className="min-w-0 break-words font-medium">{children}</span>
  ) : (
    <a className="min-w-0 break-words font-medium text-link underline" href={href}>
      {children}
    </a>
  );
}

/** One line of the card: a dot, the queue, its count and where it stands (in words, not colour). */
function Line({
  tone,
  label,
  href,
  count,
  status,
}: {
  readonly tone: WorkQueueTone;
  readonly label: string;
  readonly href: string | null;
  readonly count: string | null;
  readonly status: string;
}) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden="true" className="flex h-6 items-center">
        <span className={`block size-2 rounded-full ${DOT[tone]}`} />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <Label href={href}>{label}</Label>
        <span className="flex flex-wrap items-baseline gap-x-3 text-sm">
          {count === null ? null : <span className="font-semibold tabular-nums">{count}</span>}
          {status === '' ? null : <span className={TEXT[tone]}>{status}</span>}
        </span>
      </span>
    </li>
  );
}

function RowLine({
  row,
  labels,
  locale,
  now,
}: {
  readonly row: WorkQueueRow;
  readonly labels: WorkQueueCardLabels;
  readonly locale: string;
  readonly now: number;
}) {
  const status = workQueueStatus(row, now);
  const minutes = 'minutes' in status ? status.minutes : null;
  const age = minutes === null ? null : shortAge(minutes, locale);
  return (
    <Line
      tone={workQueueTone(status)}
      label={row.label}
      // A queue that could not be read is not a link to a count it does not have.
      href={row.state.kind === 'error' ? null : row.href}
      count={row.state.kind === 'ok' ? labels.count(row.state.count, row.state.overdue) : null}
      status={labels.status(status, age, row)}
    />
  );
}

/** A folded line: several queues as one, with their sum and their oldest item. */
function FoldedLine({
  rows,
  label,
  href,
  labels,
  locale,
  now,
}: {
  readonly rows: readonly WorkQueueRow[];
  readonly label: string;
  readonly href: string | null;
  readonly labels: WorkQueueCardLabels;
  readonly locale: string;
  readonly now: number;
}) {
  const folded = foldRows(rows);
  const at = folded.oldestAt === null ? Number.NaN : Date.parse(folded.oldestAt);
  const status = folded.failed
    ? labels.someFailed
    : Number.isNaN(at)
      ? ''
      : labels.oldest(shortAge(Math.max(0, Math.floor((now - at) / 60_000)), locale));
  return (
    <Line
      // Overdue items in a folded line keep their signal (Reza, Sajad).
      tone={folded.failed || folded.overdue > 0 ? 'critical' : 'neutral'}
      label={label}
      href={href}
      count={folded.count === null ? null : labels.count(folded.count, folded.overdue)}
      status={status}
    />
  );
}

/**
 * One level of the card. On a phone only the critical group stays open; the others fold under
 * their heading (design section 2), and open with it.
 */
function Group({
  heading,
  fixed = false,
  open = true,
  children,
}: {
  readonly heading: string;
  /** Always open, without a toggle (the critical group). */
  readonly fixed?: boolean;
  /** Whether a foldable group starts open (desktop) or folded (phone). */
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  const list = <ul className="divide-y divide-line">{children}</ul>;
  const title = 'text-xs font-semibold uppercase tracking-wide text-fg-secondary';
  if (fixed) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className={title}>{heading}</h3>
        {list}
      </div>
    );
  }
  return (
    <details open={open} className="group flex flex-col gap-1">
      <summary className={`flex min-h-12 cursor-pointer items-center gap-1 ${title}`}>
        <span className="text-icon group-open:rotate-180">
          <Icon name="chevron-down" />
        </span>
        <h3>{heading}</h3>
      </summary>
      {list}
    </details>
  );
}

/**
 * The work queue of a dashboard ("Needs action", the seller's "Today's tasks"; design section 2):
 * every critical queue, the five most urgent today queues and the rest folded into one line, the
 * review queues folded into one line, and the empty queues summed up as "All clear". A queue that
 * could not be read says so and is never 0. It is a list of queues, not a table, so the five-row
 * rule of dashboard tables does not apply to it (design section 6).
 */
export function WorkQueueCard({
  id,
  rows,
  labels,
  locale,
  now,
  open,
  levelHref,
  todayLimit = 5,
}: WorkQueueCardProps) {
  const desktop = useDesktop();
  const groups = groupWorkQueue(rows, todayLimit);
  const line = (row: WorkQueueRow) => (
    <RowLine key={row.key} row={row} labels={labels} locale={locale} now={now} />
  );
  const todayTotal = groups.today.length + groups.todayMore.length;
  const nothing = todayTotal === 0 && groups.critical.length === 0 && groups.review.length === 0;
  return (
    <DashboardCard
      id={id}
      title={labels.title}
      scope={labels.scope}
      {...(open === undefined ? {} : { action: open })}
    >
      <div className="flex flex-col gap-4">
        {groups.critical.length === 0 ? null : (
          <Group
            fixed
            heading={labels.group('critical', groups.critical.length, groups.critical.length)}
          >
            {groups.critical.map(line)}
          </Group>
        )}
        {todayTotal === 0 ? null : (
          <Group open={desktop} heading={labels.group('today', groups.today.length, todayTotal)}>
            {groups.today.map(line)}
            {groups.todayMore.length === 0 ? null : (
              <FoldedLine
                rows={groups.todayMore}
                label={labels.todayMore(groups.todayMore.length)}
                href={levelHref?.('today') ?? null}
                labels={labels}
                locale={locale}
                now={now}
              />
            )}
          </Group>
        )}
        {groups.review.length === 0 ? null : (
          <Group
            open={desktop}
            heading={labels.group('review', groups.review.length, groups.review.length)}
          >
            {groups.review.length === 1 ? (
              line(groups.review[0] as WorkQueueRow)
            ) : (
              <FoldedLine
                rows={groups.review}
                label={labels.reviewLine(
                  groups.review.slice(0, 2).map((row) => row.label),
                  groups.review.length - 2,
                )}
                href={levelHref?.('review') ?? null}
                labels={labels}
                locale={locale}
                now={now}
              />
            )}
          </Group>
        )}
        {nothing ? (
          <p className="flex items-center gap-2 text-fg-muted">
            <span className="text-success-fg">
              <Icon name="check" />
            </span>
            {labels.allClear}
          </p>
        ) : groups.clear.length === 0 ? null : (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <span className="text-success-fg">
              <Icon name="check" />
            </span>
            {labels.clear(groups.clear.length)}
          </p>
        )}
      </div>
    </DashboardCard>
  );
}
