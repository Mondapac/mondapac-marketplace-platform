// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { workQueueRows, type WorkQueueAnswer } from '@mondapac/ui';
import type * as Ui from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { ADMIN_QUEUES, adminQueue, mayHaveWorkQueue } from './queues.ts';
import { DEFAULT_QUERY, applyQuery, stateOf, viewCounts, type Query } from './work-queue-query.ts';

const mocks = vi.hoisted(() => ({ push: vi.fn(), save: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  saveFile: mocks.save,
}));

import { WorkQueueList } from './work-queue-list.tsx';

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.save.mockReset();
});

const NOW = '2026-11-22T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const ok = (key: string, level: string, count: number, overdue: number, h: number | null) => ({
  key,
  level,
  status: 'ok',
  count,
  overdue,
  oldestAt: h === null ? null : hoursAgo(h),
  countedAt: NOW,
});

const answer: WorkQueueAnswer = {
  panel: 'admin',
  generatedAt: NOW,
  queues: [
    ok('catalog.claims-without-certificate', 'critical', 0, 0, null),
    { key: 'security.open-alerts', level: 'critical', status: 'error' },
    ok('ordering.late-deliveries', 'critical', 11, 4, 48),
    ok('sellers.applications', 'today', 17, 5, 72),
    ok('pricing.price-holds', 'today', 4, 0, 9),
    ok('payments.failed-webhooks', 'today', 2, 0, 3),
    ok('catalog.brand-merges', 'review', 3, 0, 200),
  ],
};

const label = (key: string) => {
  const [module, queue] = key.split('.') as [string, string];
  const group = (messages['work-queue'].queue as Record<string, Record<string, string>>)[module];
  return group?.[queue] ?? key;
};
const define = (key: string) => {
  const queue = adminQueue(key);
  return queue === null ? null : { label: label(key), href: queue.href, signal: queue.signal };
};
const rows = workQueueRows(answer, define);
const now = Date.parse(NOW);
const keys = (query: Partial<Query>) =>
  applyQuery(rows, { ...DEFAULT_QUERY, ...query }, now, 'en-AU').map((row) => row.key);

describe('the admin queues', () => {
  it('names and links every queue the API binds, and reads only with one of their keys', () => {
    for (const queue of ADMIN_QUEUES) expect(label(queue.key)).not.toBe(queue.key);
    expect(new Set(ADMIN_QUEUES.map((queue) => queue.key)).size).toBe(ADMIN_QUEUES.length);
    expect(mayHaveWorkQueue(['catalog.brand.read'])).toBe(true);
    expect(mayHaveWorkQueue(['customers.customers.view'])).toBe(false);
  });
});

describe('the work-queue query', () => {
  it('opens on the queues that need action, most urgent first, as the card orders them', () => {
    expect(keys({})).toEqual([
      'security.open-alerts',
      'ordering.late-deliveries',
      'sellers.applications',
      'pricing.price-holds',
      'payments.failed-webhooks',
      'catalog.brand-merges',
    ]);
    expect(keys({ direction: 'desc' })[0]).toBe('catalog.brand-merges');
  });

  it('sorts by age oldest first, a row without an age last in either direction', () => {
    expect(keys({ sort: 'age' })).toEqual([
      'catalog.brand-merges',
      'sellers.applications',
      'ordering.late-deliveries',
      'pricing.price-holds',
      'payments.failed-webhooks',
      'security.open-alerts',
    ]);
    expect(keys({ sort: 'age', direction: 'desc' }).at(-1)).toBe('security.open-alerts');
  });

  it("does not take a dispute's deadline for an age", () => {
    const disputes = workQueueRows(
      {
        panel: 'admin',
        generatedAt: NOW,
        queues: [
          ok('commission-payouts.disputes-due', 'critical', 1, 0, -2),
          ok('pricing.price-holds', 'today', 4, 0, 9),
        ],
      },
      define,
    );
    const order = (sort: Query['sort']) =>
      applyQuery(disputes, { ...DEFAULT_QUERY, sort }, now, 'en-AU').map((row) => row.key);
    // Due in 2 hours: first by urgency, and no "waiting since" for the age sort.
    expect(order('urgency')[0]).toBe('commission-payouts.disputes-due');
    expect(order('age')).toEqual(['pricing.price-holds', 'commission-payouts.disputes-due']);
  });

  it('filters by view, name and state, and sorts by counts and name', () => {
    // A level view shows every queue of the level, the empty ones too.
    expect(keys({ view: 'critical' })).toEqual([
      'security.open-alerts',
      'ordering.late-deliveries',
      'catalog.claims-without-certificate',
    ]);
    expect(keys({ view: 'all' })).toContain('catalog.claims-without-certificate');
    expect(keys({ q: 'SELLER' })).toEqual(['sellers.applications']);
    expect(keys({ view: 'all', filters: { state: 'clear' } })).toEqual([
      'catalog.claims-without-certificate',
    ]);
    expect(keys({ filters: { state: 'error' } })).toEqual(['security.open-alerts']);
    expect(keys({ filters: { state: 'overdue' } })).toEqual([
      'ordering.late-deliveries',
      'sellers.applications',
    ]);
    expect(keys({ sort: 'count', direction: 'desc' }).slice(0, 2)).toEqual([
      'sellers.applications',
      'ordering.late-deliveries',
    ]);
    expect(keys({ sort: 'name', direction: 'asc' })[0]).toBe('catalog.brand-merges');
    expect(viewCounts(rows)).toEqual({
      'needs-action': 6,
      all: 7,
      critical: 3,
      today: 3,
      review: 1,
    });
    expect(stateOf(rows[0]!, now)).toBe('clear');
  });
});

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

describe('WorkQueueList', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  const list = (view: 'needs-action' | 'review' = 'needs-action') =>
    render(
      wrap(
        <WorkQueueList
          zone="Australia/Brisbane"
          answer={answer}
          initialView={view}
          accountId="a"
          marketId="AU"
        />,
      ),
    );

  it('links failed payments to the cancelled orders (drill-down), a focusable link', () => {
    render(
      wrap(
        <WorkQueueList
          zone="Australia/Brisbane"
          answer={{ ...answer, queues: [ok('ordering.failed-payments', 'today', 3, 0, 5)] }}
          initialView="needs-action"
          accountId="a"
          marketId="AU"
        />,
      ),
    );
    const link = within(screen.getByRole('table', { name: 'Work queue' })).getByRole('link', {
      name: label('ordering.failed-payments'),
    });
    expect(link.getAttribute('href')).toBe('/orders?status=cancelled');
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  it('lists every queue that needs action with its count, age and status, linked to its list', () => {
    list();
    const table = within(screen.getByRole('table', { name: 'Work queue' }));
    const applications = table.getByRole('link', { name: 'Seller applications' });
    expect(applications.getAttribute('href')).toBe('/sellers?tab=awaiting-review');
    const row = applications.closest('tr') as HTMLElement;
    expect(row.textContent).toContain('17');
    expect(row.textContent).toContain('Oldest 3d');
    // A queue without a list says so instead of linking.
    expect(table.getByText('Payment events not applied').closest('tr')?.textContent).toContain(
      'No list for these items yet',
    );
    expect(table.getByText('Security alerts open').closest('tr')?.textContent).toContain(
      "Couldn't load",
    );
    expect(screen.getByRole('button', { name: 'Needs action (6)' })).toBeTruthy();
    expect(screen.getByText('Sorted by Most urgent, Most urgent first')).toBeTruthy();
    // An empty queue is all clear, not "on time"; the level badge carries no status colour.
  });

  it('opens on the view a link asks for, and switches views with their counts', () => {
    list('review');
    const table = within(screen.getByRole('table', { name: 'Work queue' }));
    expect(table.getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'All queues (7)' }));
    expect(
      within(screen.getByRole('table', { name: 'Work queue' })).getAllByRole('row'),
    ).toHaveLength(8);
  });

  it('searches by queue name and shows a chip that clears it', () => {
    vi.useFakeTimers();
    try {
      list();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search queues' }), {
        target: { value: 'held' },
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      const table = within(screen.getByRole('table', { name: 'Work queue' }));
      expect(table.getAllByRole('row')).toHaveLength(2);
      expect(screen.getByText('1 queue matches')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Remove filter Name has “held”' }));
      expect(
        within(screen.getByRole('table', { name: 'Work queue' })).getAllByRole('row'),
      ).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says an empty queue is all clear, and a failed one exports with blank counts', async () => {
    list();
    fireEvent.click(screen.getByRole('button', { name: 'All queues (7)' }));
    const table = within(screen.getByRole('table', { name: 'Work queue' }));
    expect(
      table.getByText('Certified listings without a valid certificate').closest('tr')?.textContent,
    ).toContain('All clear');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Export the work queue' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Export' }));
    const [blob] = mocks.save.mock.calls[0] as [Blob, string];
    const text = await blob.text();
    expect(text).toContain("Security alerts open,Critical,,,,,Couldn't load");
    expect(text).toContain(
      'Certified listings without a valid certificate,Critical,0,0,,,All clear',
    );
  });

  it('exports the rows on show as CSV', async () => {
    list('review');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Export the work queue' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Export' }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [blob, filename] = mocks.save.mock.calls[0] as [Blob, string];
    expect(filename).toBe('work-queue-2026-11-22.csv');
    const text = await blob.text();
    expect(text).toContain('Queue,Level,Items,Overdue,Waiting since,Due,Status');
    expect(text).toContain(`Brand merge groups,Review,3,0,${hoursAgo(200)},,Oldest 8d`);
  });
});
