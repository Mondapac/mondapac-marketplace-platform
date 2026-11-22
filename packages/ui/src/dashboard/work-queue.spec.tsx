// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkQueueCard, type WorkQueueCardLabels } from './work-queue-card.tsx';
import {
  byUrgency,
  foldRows,
  groupWorkQueue,
  shortAge,
  workQueueRows,
  workQueueStatus,
  workQueueTone,
  type WorkQueueDefinition,
  type WorkQueueItem,
  type WorkQueueRow,
} from './work-queue.ts';

afterEach(cleanup);

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const DEFINITIONS: Record<string, WorkQueueDefinition> = {
  'catalog.claims': {
    label: 'Halal listings without a valid certificate',
    href: null,
    signal: 'incident',
  },
  'disputes.due': { label: 'Disputes · reply due in 24h', href: '/disputes', signal: 'deadline' },
  'ordering.late': {
    label: 'Orders past their delivery promise',
    href: '/shipments',
    signal: 'age',
  },
  'payments.blocked': { label: 'Payouts paused', href: '/payouts', signal: 'fix' },
};
const define = (key: string) =>
  DEFINITIONS[key] ??
  (key.startsWith('q.') ? { label: key, href: `/${key}`, signal: 'age' as const } : null);

const ok = (
  key: string,
  level: string,
  count: number,
  overdue = 0,
  oldestAt: string | null = null,
): WorkQueueItem => ({
  key,
  level,
  status: 'ok',
  count,
  overdue,
  oldestAt,
  countedAt: ago(0),
});
const rowsOf = (queues: WorkQueueItem[]) =>
  workQueueRows({ panel: 'admin', generatedAt: ago(0), queues }, define);

describe('workQueueRows', () => {
  it('keeps the known queues in order and leaves out unknown keys and bad levels', () => {
    const rows = rowsOf([
      ok('ordering.late', 'critical', 2),
      ok('nobody.knows', 'today', 3),
      ok('q.a', 'urgent', 1),
      ok('q.b', 'review', 1),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['ordering.late', 'q.b']);
    expect(rows[0]?.label).toBe('Orders past their delivery promise');
  });

  it('shows a failed or malformed count as an error, never as 0', () => {
    const rows = rowsOf([
      { key: 'q.a', level: 'today', status: 'error' },
      { key: 'q.b', level: 'today', status: 'ok' },
      { ...ok('q.c', 'today', 2, 3) },
      { ...ok('q.d', 'today', -1) },
    ]);
    expect(rows.map((row) => row.state.kind)).toEqual(['error', 'error', 'error', 'error']);
  });
});

describe('ordering and grouping', () => {
  it('puts errors first, then the most overdue, then the oldest, then the most items', () => {
    const rows = rowsOf([
      ok('q.a', 'today', 9, 0, ago(60)),
      ok('q.b', 'today', 2, 1, ago(10)),
      { key: 'q.c', level: 'today', status: 'error' },
      ok('q.d', 'today', 1, 0, ago(600)),
      ok('q.e', 'today', 5, 0, ago(60)),
    ]);
    expect(byUrgency(rows).map((row) => row.key)).toEqual(['q.c', 'q.b', 'q.d', 'q.a', 'q.e']);
  });

  it('shows every critical queue, five today queues, folds the rest and sums up the empty ones', () => {
    const rows = rowsOf([
      ok('ordering.late', 'critical', 1),
      ok('disputes.due', 'critical', 0),
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ok(`q.t${n}`, 'today', n, 0, ago(n))),
      ok('q.r1', 'review', 2, 0, ago(100)),
      ok('q.r2', 'review', 0),
    ]);
    const groups = groupWorkQueue(rows);
    expect(groups.critical.map((row) => row.key)).toEqual(['ordering.late']);
    expect(groups.today.map((row) => row.key)).toEqual(['q.t7', 'q.t6', 'q.t5', 'q.t4', 'q.t3']);
    expect(groups.todayMore.map((row) => row.key)).toEqual(['q.t2', 'q.t1']);
    expect(groups.review.map((row) => row.key)).toEqual(['q.r1']);
    expect(groups.clear.map((row) => row.key)).toEqual(['disputes.due', 'q.r2']);
  });

  it('folds rows into their sum and oldest item, and marks a failed one', () => {
    const rows = rowsOf([
      ok('q.a', 'review', 2, 0, ago(10)),
      ok('q.b', 'review', 3, 0, ago(100)),
      { key: 'q.c', level: 'review', status: 'error' },
    ]);
    expect(foldRows(rows)).toEqual({ count: 5, oldestAt: ago(100), failed: true });
  });
});

describe('status', () => {
  const one = (item: WorkQueueItem): WorkQueueRow => rowsOf([item])[0] as WorkQueueRow;

  it('says how each kind of queue stands', () => {
    expect(workQueueStatus(one(ok('catalog.claims', 'critical', 2, 2, ago(5))), NOW)).toEqual({
      kind: 'incident',
    });
    expect(workQueueStatus(one(ok('disputes.due', 'critical', 1, 0, ago(-360))), NOW)).toEqual({
      kind: 'due-in',
      minutes: 360,
    });
    expect(workQueueStatus(one(ok('disputes.due', 'critical', 1, 1, ago(30))), NOW)).toEqual({
      kind: 'overdue',
      minutes: 30,
    });
    expect(workQueueStatus(one(ok('q.a', 'today', 3, 1, ago(120))), NOW)).toEqual({
      kind: 'overdue',
      minutes: 120,
    });
    expect(workQueueStatus(one(ok('q.a', 'today', 3, 0, ago(120))), NOW)).toEqual({
      kind: 'oldest',
      minutes: 120,
    });
    expect(workQueueStatus(one(ok('q.a', 'today', 3, 0, null)), NOW)).toEqual({ kind: 'waiting' });
    expect(workQueueStatus(one(ok('q.a', 'today', 0)), NOW)).toEqual({ kind: 'clear' });
    expect(workQueueStatus(one(ok('payments.blocked', 'critical', 1, 0, ago(9))), NOW)).toEqual({
      kind: 'fix',
    });
  });

  it('gives a neutral tone to a queue in its normal state', () => {
    expect(workQueueTone({ kind: 'oldest', minutes: 5 })).toBe('neutral');
    expect(workQueueTone({ kind: 'due-in', minutes: 5 })).toBe('attention');
    expect(workQueueTone({ kind: 'overdue', minutes: 5 })).toBe('critical');
    expect(workQueueTone({ kind: 'error' })).toBe('critical');
  });

  it('writes short ages in the locale', () => {
    expect(shortAge(0, 'en-AU')).toBe('1m');
    expect(shortAge(45, 'en-AU')).toBe('45m');
    expect(shortAge(180, 'en-AU')).toBe('3h');
    expect(shortAge(47 * 60, 'en-AU')).toBe('47h');
    expect(shortAge(3 * 24 * 60, 'en-AU')).toBe('3d');
  });
});

const labels: WorkQueueCardLabels = {
  title: 'Needs action',
  scope: 'Most urgent first',
  group: (level, shown, total) =>
    level === 'today' && shown < total ? `Today · top ${shown} of ${total}` : `${level} · ${total}`,
  count: (count, overdue) => (overdue > 0 ? `${count} · ${overdue} overdue` : String(count)),
  status: (status, age) =>
    status.kind === 'error'
      ? "Couldn't load"
      : status.kind === 'incident'
        ? 'Incident'
        : status.kind === 'overdue'
          ? `Overdue${age === null ? '' : ` ${age}`}`
          : status.kind === 'due-in'
            ? `Due in ${age}`
            : status.kind === 'oldest'
              ? `Oldest ${age}`
              : '',
  todayMore: (queues) => `${queues} more queues`,
  reviewLine: (names, more) => `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
  oldest: (age) => `Oldest ${age}`,
  clear: (queues) => `${queues} queues all clear`,
  allClear: 'All clear: nothing needs action.',
  someFailed: "Some couldn't load",
};

function card(rows: WorkQueueRow[], extra: Partial<Parameters<typeof WorkQueueCard>[0]> = {}) {
  return render(
    <WorkQueueCard
      id="needs-action"
      rows={rows}
      labels={labels}
      locale="en-AU"
      now={NOW}
      open={{ href: '/work-queue', label: 'Open work queue' }}
      levelHref={(level) => `/work-queue?view=${level}`}
      {...extra}
    />,
  );
}

describe('WorkQueueCard', () => {
  it('lists each queue with its count and its status in words, linked to its list', () => {
    card(
      rowsOf([
        ok('catalog.claims', 'critical', 2, 2, ago(5)),
        ok('disputes.due', 'critical', 2, 0, ago(-360)),
        ok('ordering.late', 'critical', 11, 4, ago(2 * 24 * 60)),
      ]),
    );
    const region = within(screen.getByRole('region', { name: 'Needs action' }));
    expect(region.getByText('Halal listings without a valid certificate').tagName).toBe('SPAN');
    expect(region.getByText('Incident')).toBeTruthy();
    expect(region.getByText('Due in 6h')).toBeTruthy();
    const late = region.getByRole('link', { name: 'Orders past their delivery promise' });
    expect(late.getAttribute('href')).toBe('/shipments');
    expect(late.closest('li')?.textContent).toContain('11 · 4 overdue');
    expect(late.closest('li')?.textContent).toContain('Overdue 2d');
    expect(region.getByRole('link', { name: 'Open work queue' }).getAttribute('href')).toBe(
      '/work-queue',
    );
  });

  it("says Couldn't load for a failed queue and does not link it", () => {
    card(rowsOf([{ key: 'ordering.late', level: 'critical', status: 'error' }]));
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Orders past their delivery promise' })).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('folds the other today queues and the review queues into one line each', () => {
    card(
      rowsOf([
        ...[1, 2, 3, 4, 5, 6, 7].map((n) => ok(`q.t${n}`, 'today', n, 0, ago(n * 60))),
        ok('q.r1', 'review', 2, 0, ago(6 * 24 * 60)),
        ok('q.r2', 'review', 3, 0, ago(60)),
        ok('q.r3', 'review', 4, 0, ago(60)),
      ]),
    );
    expect(screen.getByText('Today · top 5 of 7')).toBeTruthy();
    const more = screen.getByRole('link', { name: '2 more queues' });
    expect(more.getAttribute('href')).toBe('/work-queue?view=today');
    expect(more.closest('li')?.textContent).toContain('3'); // 1 + 2
    const review = screen.getByRole('link', { name: 'q.r1, q.r3 and 1 more' });
    expect(review.getAttribute('href')).toBe('/work-queue?view=review');
    expect(review.closest('li')?.textContent).toContain('9');
    expect(review.closest('li')?.textContent).toContain('Oldest 6d');
  });

  it('sums up the empty queues, and says All clear when nothing needs action', () => {
    card(rowsOf([ok('q.a', 'today', 0), ok('q.b', 'review', 0)]));
    expect(screen.getByText('All clear: nothing needs action.')).toBeTruthy();
    cleanup();
    card(
      rowsOf([ok('ordering.late', 'critical', 1), ok('q.a', 'today', 0), ok('q.b', 'review', 0)]),
    );
    expect(screen.getByText('2 queues all clear')).toBeTruthy();
  });

  it('on a phone keeps the critical group open and folds the others under their heading', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    try {
      card(
        rowsOf([ok('ordering.late', 'critical', 1), ok('q.a', 'today', 2), ok('q.b', 'review', 3)]),
      );
      expect(screen.getByText('Orders past their delivery promise').closest('details')).toBeNull();
      const today = screen.getByRole('link', { name: 'q.a' }).closest('details');
      expect(today).not.toBeNull();
      expect(today?.open).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
