// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { QueueList } from './queue-list.tsx';
import type { Counts, RequestPage, SystemRequest } from './types.ts';

const call = vi.mocked(callApi);
const ME = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000b2';
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

const id = (n: number) => `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
const row = (n: number, over: Partial<SystemRequest> = {}): SystemRequest => ({
  id: id(n),
  number: 1040 + n,
  displayNumber: `SR-${1040 + n}`,
  area: 'money',
  subjectKind: 'commission-payouts.commission-rate',
  subjectRef: '0190a000-0000-7000-8000-0000000009ff',
  risk: 'low',
  status: 'open',
  before: null,
  after: null,
  note: `Note for request ${n}`,
  requestedBy: OTHER,
  appliedAt: '2026-11-14T01:00:00.000Z',
  reviewDueAt: '2026-11-21T01:00:00.000Z',
  overdue: false,
  decision: null,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  supersededBy: null,
  commentCount: 0,
  reviewPermission: 'system-requests.money.review',
  actions: ['open', 'copy-link', 'approve', 'reject'],
  ...over,
});
const counts = (over: Partial<Counts> = {}): Counts => ({
  'needs-my-review': 3,
  'all-open': 5,
  mine: 1,
  approved: 7,
  reverted: 2,
  overdue: 1,
  all: 15,
  ...over,
});
const page = (rows: SystemRequest[], over: Partial<RequestPage> = {}): RequestPage => ({
  rows,
  counts: counts(),
  total: rows.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  ...over,
});

function mount(paging: 'pages' | 'prev-next' = 'pages', search = '') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <QueueList
        accountId={ME}
        marketId="AU"
        csrfToken="csrf"
        zone="Australia/Brisbane"
        paging={paging}
        initialSearch={search}
      />
    </NextIntlClientProvider>,
  );
}
const lastList = () => {
  const calls = call.mock.calls.filter(([, path]) => String(path).includes('/requests?'));
  return new URLSearchParams(String(calls[calls.length - 1]?.[1]).split('?')[1]);
};

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/system-requests');
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('QueueList', () => {
  it('opens Needs my review, shows each view with its count and the rows', async () => {
    call.mockResolvedValue(ok(page([row(1, { risk: 'high', overdue: true }), row(2)])));
    mount();
    expect(await screen.findByRole('link', { name: 'SR-1041' })).toBeTruthy();
    expect(lastList().get('view')).toBe('needs-my-review');
    expect(lastList().get('sort')).toBe('applied');
    expect(lastList().get('direction')).toBe('desc');
    expect(lastList().get('page')).toBe('1');
    for (const name of [
      'Needs my review (3)',
      'All open (5)',
      'My requests (1)',
      'Approved (7)',
      'Reverted (2)',
      'Overdue (1)',
      'All (15)',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    const line = screen.getByRole('link', { name: 'SR-1041' }).closest('tr') as HTMLElement;
    expect(within(line).getByText('Note for request 1')).toBeTruthy();
    expect(within(line).getAllByText('High').length).toBeGreaterThan(0);
    expect(within(line).getByText('Overdue')).toBeTruthy();
    expect(within(line).getAllByText('Money').length).toBeGreaterThan(0);
    // The first load keeps the address in step with the list.
    expect(window.location.search).toContain('view=needs-my-review');
  });

  it('shows 10,000+ at the cap of a view count', async () => {
    call.mockResolvedValue(
      ok(page([row(1)], { counts: counts({ all: 10_000, approved: 10_000 }) })),
    );
    mount();
    expect(await screen.findByRole('button', { name: 'All (10,000+)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (10,000+)' })).toBeTruthy();
  });

  it('falls back to All open when nothing waits for the admin and no view was chosen', async () => {
    call.mockResolvedValueOnce(ok(page([], { counts: counts({ 'needs-my-review': 0 }) })));
    call.mockResolvedValueOnce(ok(page([row(1)], { counts: counts({ 'needs-my-review': 0 }) })));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('view')).toBe('all-open');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('opens the view the admin used last, and remembers a new choice', async () => {
    window.localStorage.setItem('mp:admin:AU:' + ME + ':system-requests-view', '["mine"]');
    call.mockResolvedValue(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('view')).toBe('mine');
    fireEvent.click(screen.getByRole('button', { name: 'Approved (7)' }));
    await waitFor(() => expect(lastList().get('view')).toBe('approved'));
    expect(window.localStorage.getItem('mp:admin:AU:' + ME + ':system-requests-view')).toBe(
      '["approved"]',
    );
  });

  it('applies a filter, shows a chip for each value and removes one', async () => {
    call.mockResolvedValue(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = await screen.findByRole('heading', { name: 'Filter requests' });
    const form = panel.closest('form') as HTMLElement;
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Money' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: 'High' }));
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-11-10' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastList().get('area')).toBe('money'));
    expect(lastList().get('risk')).toBe('high');
    expect(lastList().get('appliedFrom')).toBe('2026-10-31T14:00:00.000Z');
    expect(lastList().get('appliedTo')).toBe('2026-11-10T14:00:00.000Z');
    expect(screen.getByText('Area: Money')).toBeTruthy();
    expect(screen.getByText('Risk: High')).toBeTruthy();
    expect(screen.getByText('Applied: 1 Nov to 10 Nov')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Risk: High' }));
    await waitFor(() => expect(lastList().get('risk')).toBeNull());
    expect(screen.queryByText('Risk: High')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(lastList().get('area')).toBeNull());
  });

  it('hides the Status filter in a view that fixes the status and Overdue only in Overdue', async () => {
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=approved');
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const form = (await screen.findByRole('heading', { name: 'Filter requests' })).closest(
      'form',
    ) as HTMLElement;
    expect(within(form).queryByRole('checkbox', { name: 'Open' })).toBeNull();
    expect(within(form).getByRole('switch', { name: 'Overdue only' })).toBeTruthy();
    cleanup();
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=overdue');
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = (await screen.findByRole('heading', { name: 'Filter requests' })).closest(
      'form',
    ) as HTMLElement;
    expect(within(panel).queryByRole('switch')).toBeNull();
  });

  it('shows a deep-link subject as a chip', async () => {
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=all&subjectKind=wallet.market-status&subjectRef=wallet-settings');
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('subjectKind')).toBe('wallet.market-status');
    expect(lastList().get('subjectRef')).toBe('wallet-settings');
    expect(screen.getByText('Subject: wallet-settings')).toBeTruthy();
  });

  it('searches on Enter', async () => {
    call.mockResolvedValue(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    const box = screen.getByPlaceholderText('Search SR number or note');
    fireEvent.change(box, { target: { value: 'SR-1042' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(lastList().get('q')).toBe('SR-1042'));
  });

  it.each([
    ['needs-my-review', 'Nothing waiting for you'],
    ['all-open', 'No open requests'],
    ['mine', 'You have not made any reviewed changes.'],
    ['approved', 'No requests yet.'],
    ['overdue', 'Nothing is overdue.'],
  ])('shows the empty state of the %s view', async (view, text) => {
    call.mockResolvedValue(ok(page([])));
    mount('pages', `view=${view}`);
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says no request matches the filters, with a way out', async () => {
    call.mockResolvedValueOnce(ok(page([row(1)])));
    mount('pages', 'view=all&risk=high');
    await screen.findByRole('link', { name: 'SR-1041' });
    call.mockResolvedValue(ok(page([])));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Risk: High' }));
    fireEvent.change(screen.getByPlaceholderText('Search SR number or note'), {
      target: { value: 'zzz' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('Search SR number or note'), { key: 'Enter' });
    expect(await screen.findByText('No requests match these filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastList().get('q')).toBeNull());
  });

  it('shows a load error with Try again', async () => {
    call.mockResolvedValueOnce(refused(503, 'access.unavailable'));
    call.mockResolvedValueOnce(ok(page([row(1)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'SR-1041' })).toBeTruthy();
  });

  it('shows no access for a 403', async () => {
    call.mockResolvedValue(refused(403, 'access.denied'));
    mount();
    expect(await screen.findByText('You do not have access to System requests.')).toBeTruthy();
  });

  it('goes back to the defaults with a notice when the API refuses the query', async () => {
    call.mockResolvedValueOnce(refused(400, 'validation.failed'));
    call.mockResolvedValueOnce(ok(page([row(1)])));
    mount('pages', 'view=all&risk=high');
    expect(await screen.findByText('Some filters were not valid and were removed.')).toBeTruthy();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('risk')).toBeNull();
    expect(lastList().get('view')).toBe('all');
  });

  it('shows page numbers with the total in page mode and moves to the next page', async () => {
    call.mockResolvedValue(ok(page([row(1), row(2)], { total: 60 })));
    mount('pages');
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(screen.getByText('1–2 of 60')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastList().get('page')).toBe('3'));
    expect(lastList().get('pageSize')).toBe('25');
  });

  it('writes 10,000+ for a total at the cap', async () => {
    call.mockResolvedValue(ok(page([row(1)], { total: 10_000 })));
    mount('pages');
    expect(await screen.findByText('1–1 of 10,000+')).toBeTruthy();
  });

  it('walks cursors in Previous and next mode', async () => {
    call.mockResolvedValueOnce(
      ok(page([row(1)], { total: null, page: null, nextCursor: 'cur_1' })),
    );
    mount('prev-next');
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('page')).toBeNull();
    call.mockResolvedValueOnce(ok(page([row(2)], { total: null, page: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('link', { name: 'SR-1042' });
    expect(lastList().get('cursor')).toBe('cur_1');
    call.mockResolvedValueOnce(
      ok(page([row(1)], { total: null, page: null, nextCursor: 'cur_1' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('cursor')).toBeNull();
  });

  it('lists in the row menu exactly the actions the API gave', async () => {
    call.mockResolvedValue(
      ok(
        page([
          row(1, { actions: ['open', 'copy-link'] }),
          row(2, { actions: ['open', 'copy-link', 'withdraw'] }),
        ]),
      ),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1041' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Copy link',
    ]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1042' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Copy link',
      'Withdraw my change',
    ]);
  });

  it('approves one request from its row menu and loads the list again', async () => {
    call.mockResolvedValueOnce(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1041' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Approve' }));
    expect(await screen.findByRole('heading', { name: 'Approve SR-1041?' })).toBeTruthy();
    call.mockResolvedValueOnce(ok(row(1, { status: 'approved' })));
    call.mockResolvedValueOnce(ok(page([])));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await expectToast('SR-1041 approved. The change stays live.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `system-requests/admin/requests/${id(1)}/approve`,
      undefined,
      'csrf',
    );
    await waitFor(() => expect(screen.queryByRole('link', { name: 'SR-1041' })).toBeNull());
  });

  it('shows the refusal of a row decision at the top', async () => {
    call.mockResolvedValueOnce(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1041' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Approve' }));
    call.mockResolvedValueOnce(refused(403, 'system-requests.own-subject'));
    call.mockResolvedValueOnce(ok(page([row(1)])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(
      await screen.findByText(
        /You made this change, so you cannot approve or reject it. Another admin must review it\./,
      ),
    ).toBeTruthy();
  });
});

describe('QueueList bulk approve', () => {
  const tick = (number: string) =>
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${number}` }));

  it('approves the selected low-risk requests after a confirmation', async () => {
    call.mockResolvedValueOnce(ok(page([row(1), row(2)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
    tick('SR-1041');
    tick('SR-1042');
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Approve selected' }));
    expect(await screen.findByRole('heading', { name: 'Approve 2 requests?' })).toBeTruthy();
    expect(
      screen.getByText(
        "The changes stay live. You approve them as they are now; the author's values are not edited.",
      ),
    ).toBeTruthy();
    call.mockResolvedValueOnce(
      ok({
        results: [
          { requestId: id(1), outcome: 'approved' },
          { requestId: id(2), outcome: 'approved' },
        ],
      }),
    );
    call.mockResolvedValueOnce(ok(page([])));
    fireEvent.click(screen.getByRole('button', { name: 'Approve 2 requests' }));
    await expectToast('2 requests approved.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      'system-requests/admin/requests/bulk-approve',
      { requestIds: [id(1), id(2)] },
      'csrf',
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull());
  });

  it('lists what could not be approved, and keeps only those selected', async () => {
    call.mockResolvedValueOnce(ok(page([row(1), row(2), row(3)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    tick('SR-1041');
    tick('SR-1042');
    tick('SR-1043');
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    call.mockResolvedValueOnce(
      ok({
        results: [
          { requestId: id(1), outcome: 'approved' },
          { requestId: id(2), outcome: 'system-requests.own-request' },
          { requestId: id(3), outcome: 'system-requests.decided' },
        ],
      }),
    );
    call.mockResolvedValueOnce(ok(page([row(2), row(3)])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 3 requests' }));
    const result = await screen.findByRole('heading', { name: 'Approved 1 of 3' });
    const dialog = result.closest('dialog') as HTMLElement;
    expect(
      within(dialog).getByText('You made this change, so another admin must review it.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Already decided by someone else.')).toBeTruthy();
    expect(within(dialog).getByText('SR-1042')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Approved 1 of 3' })).toBeNull(),
    );
    expect(
      within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('2 selected'),
    ).toBeTruthy();
  });

  it('keeps the button disabled with the reason when a request is not low risk or not yours to review', async () => {
    call.mockResolvedValueOnce(
      ok(
        page([
          row(1),
          row(2, { risk: 'high' }),
          row(3, { actions: ['open', 'copy-link', 'withdraw'] }),
        ]),
      ),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    tick('SR-1041');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Approve selected' }).disabled,
    ).toBe(false);
    tick('SR-1042');
    tick('SR-1043');
    const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve selected' });
    expect(approve.disabled).toBe(true);
    expect(
      screen.getByText(/Only low-risk requests you may review can be approved together\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deselect 2 that cannot be approved' }));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Approve selected' }).disabled,
      ).toBe(false),
    );
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('selects all matching and approves them 100 at a time until none remain', async () => {
    call.mockResolvedValueOnce(
      ok(page([row(1), row(2)], { total: 250, counts: counts({ 'needs-my-review': 250 }) })),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 250 matching' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(bar).getByText('All 250 matching selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Approve all matching' }));
    call.mockResolvedValueOnce(ok({ approved: 100, failed: [], remaining: 150 }));
    call.mockResolvedValueOnce(ok({ approved: 100, failed: [], remaining: 50 }));
    call.mockResolvedValueOnce(
      ok({
        approved: 40,
        failed: [{ id: id(9), code: 'system-requests.not-low-risk' }],
        remaining: 0,
      }),
    );
    call.mockResolvedValueOnce(ok(page([])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve matching requests' }));
    const result = await screen.findByRole('heading', { name: 'Approved 240 of 241' });
    expect(
      within(result.closest('dialog') as HTMLElement).getByText(
        'Needs a one-by-one review (not low risk).',
      ),
    ).toBeTruthy();
    const posts = call.mock.calls.filter(([method]) => method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts[0]).toEqual([
      'POST',
      'system-requests/admin/requests/bulk-approve-matching',
      { view: 'needs-my-review' },
      'csrf',
    ]);
  });

  it('stops when a call approves nothing, rather than asking again for ever', async () => {
    call.mockResolvedValueOnce(
      ok(page([row(1)], { total: 150, counts: counts({ 'needs-my-review': 150 }) })),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 150 matching' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve all matching' }));
    call.mockResolvedValueOnce(ok({ approved: 0, failed: [], remaining: 150 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve matching requests' }));
    expect(await screen.findByRole('heading', { name: 'Approved 0 of 0' })).toBeTruthy();
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });
});
