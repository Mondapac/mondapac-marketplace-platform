// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import messages from '../../messages/en.json';
import type { callApi } from '../api/client.ts';

// The queue's own routes answer through `call`; the saved filters (the lists module's generic
// routes) through `saved`, so a test of the queue does not have to answer them in turn.
const { call, saved } = vi.hoisted(() => ({
  call: vi.fn<typeof callApi>(),
  saved: vi.fn<typeof callApi>(),
}));
vi.mock('../api/client.ts', () => ({
  callApi: (...args: Parameters<typeof callApi>) =>
    String(args[1]).startsWith('lists/admin/saved-filters') ? saved(...args) : call(...args),
}));

import { toast } from '@mondapac/ui';
import { expectToast } from '../../test/toast-spy.ts';
import { QueueList } from './queue-list.tsx';
import type { Counts, RequestPage, SystemRequest } from './types.ts';

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
  mode: 'review',
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
  saved.mockResolvedValue({ ok: true, status: 200, body: { items: [], canShare: false } });
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

const made = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: id(index + 100),
    number: index + 1,
    displayNumber: `SR-${index + 1}`,
  }));

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

  it('lays a phone card out with a 44 px number link, room for the menu and the whole note', async () => {
    call.mockResolvedValue(ok(page([row(1, { note: 'x'.repeat(200) })])));
    mount();
    const link = await screen.findByRole('link', { name: 'SR-1041' });
    expect(link.className).toContain('max-lg:min-h-11');
    const line = link.closest('tr') as HTMLElement;
    // The status cell clears the 44 px menu button, and the note spans the card, never clamped.
    expect(within(line).getByText('Open').closest('td')?.className).toContain('max-lg:pe-14');
    const note = within(line).getByText('x'.repeat(200));
    expect(note.className).toContain('max-lg:col-span-2');
    expect(note.className).not.toContain('line-clamp');
    expect(link.closest('th')?.className).toContain('max-lg:contents');
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

  it('lists Withdraw my request in the menu of an approval row to its author', async () => {
    call.mockResolvedValueOnce(
      ok(
        page([
          row(1, {
            mode: 'approval',
            requestedBy: ME,
            actions: ['open', 'copy-link', 'withdraw'],
          }),
        ]),
      ),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1041' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Open',
      'Copy link',
      'Withdraw my request',
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

  it('shows the badge on an approval row and never offers it to bulk approve', async () => {
    call.mockResolvedValueOnce(ok(page([row(1), row(2, { mode: 'approval' })])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(screen.getAllByText('Waits for approval')).toHaveLength(1);
    tick('SR-1042');
    const approve = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve selected' });
    expect(approve.disabled).toBe(true);
    expect(
      screen.getByText(/Actions that wait for approval are applied on their own approval\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Deselect 1 that cannot be approved' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull());
    // The row's own menu words reject for an action that was never applied.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for SR-1042' }));
    expect(screen.getByRole('menuitem', { name: 'Reject' })).toBeTruthy();
  });

  it('words the one-by-one outcome of a bulk approve', async () => {
    call.mockResolvedValueOnce(ok(page([row(1), row(2)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    tick('SR-1041');
    tick('SR-1042');
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    call.mockResolvedValueOnce(
      ok({
        results: [
          { requestId: id(1), outcome: 'approved' },
          { requestId: id(2), outcome: 'system-requests.one-by-one' },
        ],
      }),
    );
    call.mockResolvedValueOnce(ok(page([row(2)])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve 2 requests' }));
    expect(await screen.findByText('Waits for approval: approve it on its own page.')).toBeTruthy();
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
    call.mockResolvedValueOnce(ok({ approved: made(100), failed: [], remaining: 150 }));
    call.mockResolvedValueOnce(ok({ approved: made(100), failed: [], remaining: 50 }));
    call.mockResolvedValueOnce(
      ok({
        approved: made(40),
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
    call.mockResolvedValueOnce(ok({ approved: [], failed: [], remaining: 150 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve matching requests' }));
    await expectToast('No matching low-risk requests could be approved.', 'info');
    expect(screen.queryByRole('heading', { name: /Approved 0 of 0/ })).toBeNull();
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('shows the number of a failed row that the answer names, or its short id', async () => {
    call.mockResolvedValueOnce(
      ok(page([row(1)], { total: 150, counts: counts({ 'needs-my-review': 150 }) })),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 150 matching' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve all matching' }));
    call.mockResolvedValueOnce(
      ok({
        approved: made(2),
        failed: [{ id: id(9), code: 'system-requests.decided' }],
        remaining: 0,
      }),
    );
    call.mockResolvedValueOnce(ok(page([])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve matching requests' }));
    const result = await screen.findByRole('heading', { name: 'Approved 2 of 3' });
    expect(
      within(result.closest('dialog') as HTMLElement).getByText('Already decided by someone else.'),
    ).toBeTruthy();
  });

  it('stops when the server cannot count what is left, and says it can be run again', async () => {
    call.mockResolvedValueOnce(
      ok(page([row(1)], { total: 150, counts: counts({ 'needs-my-review': 150 }) })),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 150 matching' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve all matching' }));
    call.mockResolvedValueOnce(ok({ approved: made(100), failed: [], remaining: null }));
    call.mockResolvedValueOnce(ok(page([])));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve matching requests' }));
    const result = await screen.findByRole('heading', { name: 'Approved 100 of 100' });
    expect(
      within(result.closest('dialog') as HTMLElement).getByText(/could not be counted/),
    ).toBeTruthy();
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });
});

describe('QueueList saved filters', () => {
  const LIST_KEY = 'admin.system-requests.requests';
  const stored = (n: number, name: string, payload: unknown) => ({
    id: `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`,
    listKey: LIST_KEY,
    name,
    visibility: 'me',
    payload,
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-14T01:00:00.000Z',
    updatedAt: '2026-11-14T01:00:00.000Z',
  });
  const serve = (items: unknown[], canShare = false) =>
    saved.mockImplementation((method, _path, body) => {
      if (method === 'POST') {
        const sent = body as { name: string; payload: unknown };
        const created = stored(9, sent.name, sent.payload);
        items.push(created);
        return Promise.resolve({ ok: true, status: 201, body: created });
      }
      return Promise.resolve({ ok: true, status: 200, body: { items: [...items], canShare } });
    });

  it('shows saved filters as tabs after the views, and opens one with its filters and sort', async () => {
    serve([
      stored(1, 'Urgent money', {
        v: 1,
        view: 'all-open',
        filters: { area: ['money'], risk: ['high'], overdue: true },
        sort: 'due',
      }),
    ]);
    call.mockResolvedValue(ok(page([row(1)])));
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(saved).toHaveBeenCalledWith('GET', `lists/admin/saved-filters?listKey=${LIST_KEY}`);
    expect(await screen.findByRole('button', { name: 'Manage filters' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Urgent money' }));
    await waitFor(() => expect(lastList().get('view')).toBe('all-open'));
    expect(lastList().get('area')).toBe('money');
    expect(lastList().get('risk')).toBe('high');
    expect(lastList().get('overdue')).toBe('true');
    expect(lastList().get('sort')).toBe('due');
    expect(lastList().get('direction')).toBe('asc');
    expect(screen.getByRole('button', { name: 'Urgent money' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // A built-in view opened from the saved tab starts from the defaults.
    fireEvent.click(screen.getByRole('button', { name: /^All \(/ }));
    await waitFor(() => expect(lastList().get('view')).toBe('all'));
    expect(lastList().get('area')).toBeNull();
    expect(lastList().get('sort')).toBe('applied');
  });

  it("keeps the built-in views' counts when a saved filter is open", async () => {
    serve([
      stored(1, 'Urgent money', {
        v: 1,
        view: 'all-open',
        filters: { area: ['money'], risk: ['high'], overdue: true },
        sort: 'due',
      }),
    ]);
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        ok(
          String(path).includes('area=money')
            ? page([row(1)], { counts: counts({ 'needs-my-review': 0, approved: 0, all: 1 }) })
            : page([row(1)]),
        ),
      ),
    );
    mount();
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(await screen.findByRole('button', { name: 'Urgent money' }));
    await waitFor(() => expect(lastList().get('area')).toBe('money'));
    // The saved filter narrows its own list only; the other views still count their own rows.
    expect(await screen.findByRole('button', { name: 'Needs my review (3)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved (7)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All (15)' })).toBeTruthy();
  });

  it('saves the view, filters and sort as the canonical payload, never the search', async () => {
    serve([]);
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=all&q=limit&area=people,money&risk=low&from=2026-11-01&sort=number');
    await screen.findByRole('button', { name: 'Manage filters' });
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    expect(
      within(dialog).getByText('Saved for you only. Your role can’t share filters.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'People' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'People' });
    expect(saved).toHaveBeenCalledWith(
      'POST',
      'lists/admin/saved-filters',
      {
        listKey: LIST_KEY,
        name: 'People',
        visibility: 'me',
        payload: {
          v: 1,
          view: 'all',
          filters: { area: ['people', 'money'], risk: ['low'], from: '2026-11-01' },
          sort: 'number',
        },
      },
      'csrf',
    );
  });

  it('offers Everyone to an admin who can share', async () => {
    serve([], true);
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=all');
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Everyone' }));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await screen.findByRole('button', { name: 'Team' });
    expect(saved.mock.calls.find(([method]) => method === 'POST')?.[2]).toMatchObject({
      visibility: 'everyone',
    });
  });

  it('keeps the built-in views only when the saved filters cannot be read', async () => {
    saved.mockResolvedValue(refused(403, 'access.denied'));
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=all');
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
  });
});

describe('QueueList export', () => {
  const fetched: string[] = [];
  const names: string[] = [];
  let click: { mockRestore: () => void };
  let promised: MockInstance<typeof toast.promise>;
  const tick = (number: string) =>
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${number}` }));
  /** The words the export's toast ends on: its success or its error, as the toast shows them. */
  const outcome = async (): Promise<string> => {
    await waitFor(() => expect(promised).toHaveBeenCalled());
    const [work, words] = promised.mock.calls[0]!;
    try {
      const rows = await work;
      return typeof words.success === 'function' ? words.success(rows) : words.success;
    } catch (reason) {
      return typeof words.error === 'function' ? words.error(reason) : words.error;
    }
  };
  const answerCsv = (text: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response(text, {
            status: 200,
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': 'attachment; filename="system-requests-2026-11-15.csv"',
            },
          }),
        );
      }),
    );
  const exportAs = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /^CSV/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };

  beforeEach(() => {
    fetched.length = 0;
    names.length = 0;
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    promised = vi.spyOn(toast, 'promise');
  });
  afterEach(() => {
    click.mockRestore();
    promised.mockRestore();
    vi.unstubAllGlobals();
  });

  it('exports every row the view and filters match, in the list order, with the columns shown', async () => {
    call.mockResolvedValue(ok(page([row(1), row(2)])));
    mount('pages', 'view=all&risk=high&sort=number&direction=asc');
    await screen.findByRole('link', { name: 'SR-1041' });
    answerCsv('\uFEFFRequest,Note\r\nSR-1041,a\r\nSR-1042,b\r\n');
    await exportAs();
    expect(await outcome()).toBe('Exported 2 rows.');
    expect(fetched).toHaveLength(1);
    const [path, search] = fetched[0]!.split('?');
    expect(path).toBe('/api/system-requests/admin/requests/export');
    const params = new URLSearchParams(search);
    expect(params.get('view')).toBe('all');
    expect(params.get('risk')).toBe('high');
    expect(params.get('sort')).toBe('number');
    expect(params.get('direction')).toBe('asc');
    expect(params.get('format')).toBe('csv');
    expect(params.get('columns')).toBe('subject,requestedBy,applied,due');
    expect(params.get('zone')).toBe('Australia/Brisbane');
    expect(params.has('ids')).toBe(false);
    expect(params.has('page')).toBe(false);
    expect(params.has('pageSize')).toBe(false);
    expect(names).toEqual(['system-requests-2026-11-15.csv']);
  });

  it('exports only the ticked rows', async () => {
    call.mockResolvedValue(ok(page([row(1), row(2), row(3)])));
    mount('pages', 'view=all');
    await screen.findByRole('link', { name: 'SR-1041' });
    tick('SR-1043');
    tick('SR-1041');
    answerCsv('\uFEFFRequest\r\nSR-1043\r\nSR-1041\r\n');
    await exportAs();
    expect(await outcome()).toBe('Exported 2 rows.');
    const params = new URLSearchParams(fetched[0]!.split('?')[1]);
    expect(params.get('ids')).toBe(`${id(3)},${id(1)}`);
  });

  it('says how far to narrow when the filter matches too many rows', async () => {
    call.mockResolvedValue(ok(page([row(1)])));
    mount('pages', 'view=all');
    await screen.findByRole('link', { name: 'SR-1041' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12345 } }),
            { status: 413, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );
    await exportAs();
    expect(await outcome()).toBe(
      'Too many rows to export: 12,345 match, and one file holds up to 10,000. Narrow the filter or select fewer rows.',
    );
  });

  it('titles the dialog with the rows the search and filters match, or all matching at the cap', async () => {
    // The API counts each view for the same search and filters: 2 of the view's rows match.
    call.mockResolvedValue(ok(page([row(1), row(2)], { counts: counts({ all: 2 }) })));
    mount('pages', 'view=all&q=limit&risk=high');
    await screen.findByRole('link', { name: 'SR-1041' });
    expect(lastList().get('q')).toBe('limit');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('heading', { name: 'Export 2 rows' })).toBeTruthy();
    cleanup();

    call.mockResolvedValue(ok(page([row(1)], { counts: counts({ all: 10_000 }) })));
    mount('pages', 'view=all&risk=high');
    await screen.findByRole('link', { name: 'SR-1041' });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('heading', { name: 'Export all matching rows' })).toBeTruthy();
  });

  it('titles the dialog with the ticked rows when rows are ticked', async () => {
    call.mockResolvedValue(ok(page([row(1), row(2), row(3)])));
    mount('pages', 'view=all');
    await screen.findByRole('link', { name: 'SR-1041' });
    tick('SR-1042');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('heading', { name: 'Export 1 row' })).toBeTruthy();
  });

  it('offers no export while the view is empty', async () => {
    call.mockResolvedValue(
      ok(page([], { counts: counts({ 'needs-my-review': 0, 'all-open': 0 }) })),
    );
    mount('pages', 'view=all-open');
    await screen.findByRole('button', { name: /^All open/ });
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true),
    );
  });
});
