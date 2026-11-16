// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems, toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { adminNav } from '../../nav.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { RefundsList } from './refunds-list.tsx';
import { cleanColumns } from './refunds-columns.ts';
import type { RefundRow, RefundsPage } from './refunds-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
const LOS_ANGELES = 'America/Los_Angeles';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane, still the 16th in Los Angeles.
const NOW = new Date('2026-11-16T20:30:00.000Z');

const ORDER = '0190a000-0000-7000-8000-000000000001';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const ACCOUNT = '0190a000-0000-7000-8000-0000000000c1';
const REFUND = '0190a000-0000-7000-8000-0000000000f1';
const refundId = (n: number) => `0190a000-0000-7000-8000-0000000000f${n}`;
const cursor = (n: number) => `${1763300000000 + n}.0190a000-0000-7000-8000-0000000000a${n}`;
const money = (amount: string, currency = 'AUD') => ({ amount, currency });

const row = (over: Partial<RefundRow> = {}): RefundRow => ({
  refundId: REFUND,
  orderId: ORDER,
  sellerOrderId: '0190a000-0000-7000-8000-0000000000d1',
  sellerId: SELLER,
  storeName: 'Cedar Lane Halal Meats',
  accountId: ACCOUNT,
  customer: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
  gross: money('12550'),
  tax: money('1141'),
  shippingGross: money('990'),
  reason: 'damaged',
  actor: 'admin',
  state: 'succeeded',
  lossBearer: 'seller',
  lossReasonCode: null,
  stripeRefundId: 're_3Pabc123',
  requestedAt: '2026-11-10T01:30:00.000Z',
  settledAt: '2026-11-10T03:00:00.000Z',
  ledgerRecordedAt: '2026-11-10T03:05:00.000Z',
  creditNoteId: '0190a000-0000-7000-8000-0000000000e1',
  actions: ['view-order', 'copy-stripe-reference'],
  ...over,
});
const COUNTS = { pending: 3, succeeded: 20, failed: 2 };
const pageOf = (refunds: RefundRow[], over: Partial<RefundsPage> = {}): RefundsPage => ({
  refunds,
  counts: COUNTS,
  total: refunds.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  searchCapped: false,
  searchScope: null,
  ...over,
});
/** The answer of Previous and next: no total, no page. */
const cursorPage = (refunds: RefundRow[], nextCursor: string | null = null) =>
  pageOf(refunds, { total: null, page: null, nextCursor });

type Answer = RefundsPage | 'fail' | 'denied' | 'unauthenticated' | 'search-down';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => Answer) {
  call.mockImplementation((_method, path) => {
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    if (result === 'denied') {
      return Promise.resolve({ ok: false, failure: { status: 403, code: 'access.denied' } });
    }
    if (result === 'unauthenticated') {
      return Promise.resolve({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    }
    if (result === 'search-down') {
      return Promise.resolve({
        ok: false,
        failure: { status: 503, code: 'ordering.search-unavailable' },
      });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const urls = () => call.mock.calls.map((entry) => entry[1]);
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    sellerId?: string | null;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RefundsList
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId={options.marketId ?? 'AU'}
        zone={options.zone ?? BRISBANE}
        sellerId={options.sellerId ?? null}
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const STORE = 'Cedar Lane Halal Meats';

describe('Refunds page numbers', () => {
  it('asks for page 1, Requested newest first, and shows the header, tabs and sorted line', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    expect(await screen.findByRole('link', { name: 'Order 00000001' })).toBeTruthy();
    expect(urls()[0]).toBe(
      'ordering/admin/refunds?page=1&pageSize=25&sort=requested&direction=desc',
    );
    expect(
      screen.getByText('Every refund in this Market. To refund an order, open the order.'),
    ).toBeTruthy();
    expect(screen.getByText('Times and days are in Australia/Brisbane.')).toBeTruthy();
    expect(screen.getByText('Sorted by Requested: Newest first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy();
    expect(screen.getByText('1 to 1 of 143')).toBeTruthy();
    // Read only: no refund or retry button, and the saved filter UI is hidden.
    expect(screen.queryByRole('button', { name: /^(Refund|Retry refund|Retry)$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save filter/ })).toBeNull();
  });

  it('shows the tab counts: All is pending plus succeeded plus failed', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(screen.getByRole('button', { name: 'All (25)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    for (const name of ['Waiting for Stripe (3)', 'Refunded (20)', 'Refused by Stripe (2)']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('sends state for a state tab and nothing for All, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: /^Waiting for Stripe/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['state']).toBe('pending'));
    expect(paramsOf(lastUrl())).toMatchObject({ page: '1' });
    fireEvent.click(screen.getByRole('button', { name: /^Refused by Stripe/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['state']).toBe('failed'));
    fireEvent.click(screen.getByRole('button', { name: /^Refunded/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['state']).toBe('succeeded'));
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('state'));
  });

  it('sorts by Amount, highest first, then Settled, and then lowest first', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=amount&direction=desc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=amount&direction=asc'));
    expect(screen.getByText('Sorted by Amount: Lowest first')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Settled' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=settled&direction=desc'));
  });

  it('stops page numbers at row 10,000, with the banner, and sends no page past 400', async () => {
    serve((url) => pageOf([row()], { total: 12_345, page: Number(paramsOf(url)['page']) }));
    mount();
    await screen.findByText(STORE);
    expect(
      screen.getByText(/Page numbers stop at the first 10,000 refunds\. Narrow the filters/),
    ).toBeTruthy();
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 400' }));
    await waitFor(() => expect(lastUrl()).toContain('page=400'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true),
    );
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
    expect(screen.queryByText('Narrow the list to see more.')).toBeNull();
  });

  it('goes back to the last page that has rows when the page asked for is empty', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '2'
        ? pageOf([], { total: 25, page: 2 })
        : pageOf([row()], { total: 30, page: 1 }),
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(urls().some((url) => url.includes('page=2'))).toBe(true));
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
    expect(await screen.findByText(STORE)).toBeTruthy();
  });
});

describe('Refunds Previous and next', () => {
  it('sends the limit alone, hides Sort, says Newest first and shows no total', async () => {
    serve(() => cursorPage([row()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(urls()[0]).toBe('ordering/admin/refunds?limit=25');
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    expect(screen.getByText('Newest first')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'All (25)' })).toBeTruthy();
  });

  it('walks the cursor stack forward and back, never mixing a cursor with page or sort', async () => {
    serve((url) => {
      const sent = paramsOf(url)['cursor'];
      if (sent === undefined) return cursorPage([row({ storeName: 'First Store' })], cursor(1));
      if (sent === cursor(1)) return cursorPage([row({ storeName: 'Second Store' })], cursor(2));
      return cursorPage([row({ storeName: 'Third Store' })], null);
    });
    mount({ paging: 'prev-next' });
    await screen.findByText('First Store');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Second Store');
    expect(lastUrl()).toBe(
      `ordering/admin/refunds?limit=25&cursor=${encodeURIComponent(cursor(1))}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Third Store');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Second Store');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('First Store');
    expect(lastUrl()).toBe('ordering/admin/refunds?limit=25');
    for (const url of urls()) {
      for (const key of ['page', 'pageSize', 'sort', 'direction']) {
        expect(paramsOf(url)).not.toHaveProperty(key);
      }
    }
  });

  it('starts again from the first cursor when a tab changes', async () => {
    serve((url) =>
      paramsOf(url)['cursor'] === undefined
        ? cursorPage([row()], cursor(1))
        : cursorPage([row()], null),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('cursor='));
    fireEvent.click(screen.getByRole('button', { name: /^Refused by Stripe/ }));
    await waitFor(() => expect(lastUrl()).toBe('ordering/admin/refunds?state=failed&limit=25'));
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
  });

  it('offers "Select all matching" without a number', async () => {
    serve(() => cursorPage([row()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching refunds are selected')).toBeTruthy();
  });
});

describe('Refunds search', () => {
  const ID = '0190a000-0000-7000-8000-0000000000e5';
  const box = () => screen.getByRole('searchbox', { name: 'Search' });

  it('shows the label, the placeholder and no scope select', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(box().getAttribute('placeholder')).toBe(
      'Customer, store, order or refund ID, or Stripe ID',
    );
    expect(screen.queryByLabelText('Search by')).toBeNull();
  });

  it('sends a UUID and a re_ id as q on Enter, and a name as search after the typing pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.change(box(), { target: { value: ` ${ID} ` } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
    expect(paramsOf(lastUrl())).not.toHaveProperty('search');
    expect(screen.getByText(`Search: "${ID}"`)).toBeTruthy();

    fireEvent.change(box(), { target: { value: 're_3Pabc123' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('re_3Pabc123'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('search');
    expect(screen.getByText('Search: "re_3Pabc123"')).toBeTruthy();

    fireEvent.change(box(), { target: { value: ' Cedar ' } });
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('Cedar'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('q');
    expect(screen.getByText('Search: "Cedar"')).toBeTruthy();
  });

  it('asks for nothing from one character and shows the hint under the box', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const before = urls().length;
    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    expect(urls()).toHaveLength(before);
    expect(screen.queryByText(/^Search: /)).toBeNull();
    fireEvent.change(box(), { target: { value: 'ab' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('ab'));
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
  });

  it('removes the search with its chip and clears the box', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText('Search: "Cedar"');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('search'));
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('says when only store names were searched, and when the search was capped', async () => {
    serve((url) =>
      url.includes('search=')
        ? pageOf([row()], { searchScope: 'stores', searchCapped: true })
        : pageOf([row()]),
    );
    mount();
    await screen.findByText(STORE);
    expect(screen.queryByText(/Only store names were searched/)).toBeNull();
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/Only store names were searched\./)).toBeTruthy();
    expect(screen.getByText(/More than 200 customers or stores match/)).toBeTruthy();
  });

  it('replaces the table with a critical banner when name search is down, keeping chips and counts', async () => {
    serve((url) => (url.includes('search=') ? 'search-down' : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(
      await screen.findByText("Name search isn't available right now. Try again, or search by ID."),
    ).toBeTruthy();
    expect(screen.queryByText(STORE)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Search: "Cedar"')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All (25)' })).toBeTruthy();
    const before = urls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(urls().length).toBe(before + 1));
    expect(lastUrl()).toContain('search=Cedar');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    expect(await screen.findByText(STORE)).toBeTruthy();
  });
});

describe('Refunds filters', () => {
  async function addCondition(field: string, value: string, first = true) {
    if (first) fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    if (!first) fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const index = first ? 0 : within(panel).getAllByLabelText('Field').length - 1;
    fireEvent.change(within(panel).getAllByLabelText('Field')[index]!, {
      target: { value: field },
    });
    fireEvent.change(within(panel).getAllByLabelText('Value')[index]!, { target: { value } });
    return panel;
  }
  const apply = (panel: HTMLElement) =>
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

  it('offers the five fields with their values', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const field = within(panel).getByLabelText('Field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Reason', 'Requested by', 'Loss borne by', 'Seller ledger', 'Requested']);
    const values = (name: string) => {
      fireEvent.change(field, { target: { value: name } });
      return within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .slice(1);
    };
    expect(values('reason')).toEqual([
      'Not received',
      'Damaged',
      'Wrong item',
      'Not as described',
      'Seller cancelled',
      'Item unavailable',
      'Other',
    ]);
    expect(values('actor')).toEqual(['Admin', 'Seller']);
    expect(values('lossBearer')).toEqual(['Seller', 'Platform']);
    expect(values('ledger')).toEqual(['Waiting', 'Recorded']);
    expect(values('requested')).toEqual([
      'Today',
      'Yesterday',
      'Last 7 days',
      'Last 30 days',
      'This month',
      'Last month',
    ]);
  });

  it('filters by reason, requester, loss bearer and ledger, as chips that can be removed', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    await addCondition('reason', 'item-unavailable');
    await addCondition('actor', 'seller', false);
    await addCondition('lossBearer', 'platform', false);
    apply(await addCondition('ledger', 'recorded', false));
    await waitFor(() => expect(paramsOf(lastUrl())['ledger']).toBe('recorded'));
    expect(paramsOf(lastUrl())).toMatchObject({
      reason: 'item-unavailable',
      actor: 'seller',
      lossBearer: 'platform',
    });
    expect(screen.getByText('Reason is Item unavailable')).toBeTruthy();
    expect(screen.getByText('Requested by is Seller')).toBeTruthy();
    expect(screen.getByText('Loss borne by is Platform')).toBeTruthy();
    expect(screen.getByText('Seller ledger is Recorded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (4)' })).toBeTruthy();
    expect(screen.getByText('1 refund matches')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Requested by is Seller' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('actor'));
    expect(paramsOf(lastUrl())['reason']).toBe('item-unavailable');
  });

  it('reads the Requested preset on the clock of the list zone, Brisbane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount({ zone: BRISBANE });
    await screen.findByText(STORE);
    apply(await addCondition('requested', 'today'));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(screen.getByText('Requested is Today')).toBeTruthy();
  });

  it('reads the same preset on another zone, Los Angeles, at the same instant', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText(STORE);
    apply(await addCondition('requested', 'last-month'));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-10-01T07:00:00.000Z',
      to: '2026-11-01T07:00:00.000Z',
    });
  });

  it('gives an empty list, with no special case, for "Seller ledger is Waiting" on the Refused tab', async () => {
    serve((url) =>
      paramsOf(url)['state'] === 'failed' && paramsOf(url)['ledger'] === 'waiting'
        ? pageOf([])
        : pageOf([row()]),
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: /^Refused by Stripe/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['state']).toBe('failed'));
    apply(await addCondition('ledger', 'waiting'));
    expect(await screen.findByRole('heading', { name: 'No refunds match' })).toBeTruthy();
    // Both go to the API as an AND, and the page does not drop or explain the pair.
    expect(paramsOf(lastUrl())).toMatchObject({ state: 'failed', ledger: 'waiting' });
    expect(screen.getByText('Seller ledger is Waiting')).toBeTruthy();
  });

  it('shows a removable Seller chip when a link names one, with the store name or the short id', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(`Seller is ${STORE}`);
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    fireEvent.click(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
  });

  it('names the seller by its short id when no row knows the store', async () => {
    serve(() => pageOf([row({ storeName: null })]));
    mount({ sellerId: SELLER });
    expect(await screen.findByText('Seller is 000000B1')).toBeTruthy();
  });

  it('offers no seller or amount filter in the panel', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const names = within(within(panel).getByLabelText('Field'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names.join('|')).not.toMatch(/Seller\||Amount|Store/);
  });

  it('clears the search, filters and seller together with Clear all, keeping the tab', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(`Seller is ${STORE}`);
    fireEvent.click(screen.getByRole('button', { name: /^Refunded/ }));
    apply(await addCondition('reason', 'damaged'));
    await screen.findByText('Reason is Damaged');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('reason'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId');
    expect(paramsOf(lastUrl())['state']).toBe('succeeded');
  });
});

describe('Refunds rows', () => {
  it('shows the default columns, money in the row currency (two currencies) and times in the zone', async () => {
    serve(() =>
      pageOf([
        row(),
        row({ refundId: refundId(2), storeName: 'Zed Store', gross: money('48000', 'ZZD') }),
      ]),
    );
    mount();
    await screen.findByText('Zed Store');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'State',
      'Amount (incl. tax)',
      'Reason',
      'Requested by',
      'Store',
      'Customer',
      'Requested',
      'Loss borne by',
      'Actions',
    ]);
    const first = screen.getAllByRole('row')[1]!;
    expect(within(first).getByText('$125.50')).toBeTruthy();
    expect(within(first).getByText('$125.50').className).toContain('font-medium');
    // 2026-11-10 01:30 UTC is 11:30 am in Brisbane.
    expect(within(first).getByText('10 Nov, 11:30 am')).toBeTruthy();
    expect(within(first).getByText('Refunded')).toBeTruthy();
    expect(within(first).getByText('Damaged')).toBeTruthy();
    expect(within(first).getByText('Admin')).toBeTruthy();
    expect(within(first).getByText('Seller')).toBeTruthy();
    expect(within(first).getByText('Ada Lovelace')).toBeTruthy();
    const second = screen.getAllByRole('row')[2]!;
    expect(within(second).getByText(/480\.00/)).toBeTruthy();
    expect(within(second).queryByText('$480.00')).toBeNull();
    const link = within(first).getByRole('link', { name: 'Order 00000001' });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER}`);
    expect(link.getAttribute('title')).toBe(ORDER);
  });

  it('shows the same times on another zone (Los Angeles)', async () => {
    serve(() => pageOf([row()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText(STORE);
    // 2026-11-10 01:30 UTC is 9 Nov 5:30 pm in Los Angeles.
    expect(screen.getByText('9 Nov, 5:30 pm')).toBeTruthy();
    expect(screen.getByText('Times and days are in America/Los_Angeles.')).toBeTruthy();
  });

  it('words the three states as the order page does, with a tone each', async () => {
    serve(() =>
      pageOf([
        row({ state: 'pending' }),
        row({ refundId: refundId(2), state: 'succeeded' }),
        row({ refundId: refundId(3), state: 'failed' }),
        row({ refundId: refundId(4), state: 'mystery' }),
      ]),
    );
    mount();
    await screen.findAllByText(STORE);
    const body = screen.getAllByRole('row').slice(1);
    expect(within(body[0]!).getByText('Waiting for Stripe')).toBeTruthy();
    expect(within(body[1]!).getByText('Refunded')).toBeTruthy();
    expect(within(body[2]!).getByText('Refused by Stripe')).toBeTruthy();
    expect(within(body[3]!).getByText('Unknown')).toBeTruthy();
  });

  it('shows Seller or Platform for who bears the loss, and the loss reason under Platform', async () => {
    serve(() =>
      pageOf([
        row({ lossBearer: 'seller' }),
        row({ refundId: refundId(2), lossBearer: 'platform', lossReasonCode: 'carrier-loss' }),
        row({ refundId: refundId(3), lossBearer: 'platform', lossReasonCode: 'newcode' }),
        row({ refundId: refundId(4), lossBearer: 'platform', lossReasonCode: null }),
      ]),
    );
    mount();
    await screen.findAllByText(STORE);
    const body = screen.getAllByRole('row').slice(1);
    // The seller row has no second line; the reason of a platform row is muted under it.
    expect(within(body[0]!).queryByText('Lost by the carrier')).toBeNull();
    expect(within(body[1]!).getByText('Platform')).toBeTruthy();
    const reason = within(body[1]!).getByText('Lost by the carrier');
    expect(reason.className).toContain('text-fg-muted');
    expect(within(body[2]!).getByText('Other')).toBeTruthy();
    expect(within(body[3]!).getByText('Platform')).toBeTruthy();
  });

  it('shows every reason, including Item unavailable, in the order page words', async () => {
    const reasons = [
      'not-received',
      'damaged',
      'wrong-item',
      'not-as-described',
      'seller-cancelled',
      'item-unavailable',
      'other',
    ];
    serve(() => pageOf(reasons.map((reason, n) => row({ refundId: refundId(n), reason }))));
    mount();
    await screen.findAllByText(STORE);
    const cells = screen.getAllByRole('row').slice(1);
    expect(cells.map((tr) => within(tr).getAllByRole('cell')[4]?.textContent)).toEqual([
      'Not received',
      'Damaged',
      'Wrong item',
      'Not as described',
      'Seller cancelled',
      'Item unavailable',
      'Other',
    ]);
  });

  it('shows the optional columns, with the Seller ledger waiting badge, Not yet and None', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:refunds-columns',
      JSON.stringify(['ledger', 'tax', 'shipping', 'settled']),
    );
    serve(() =>
      pageOf([
        // Succeeded and recorded.
        row(),
        // Succeeded, not in the seller ledger yet.
        row({ refundId: refundId(2), ledgerRecordedAt: null, shippingGross: money('0') }),
        // Pending: no ledger, no settlement.
        row({
          refundId: refundId(3),
          state: 'pending',
          ledgerRecordedAt: null,
          settledAt: null,
          stripeRefundId: null,
          creditNoteId: null,
        }),
        // Failed: nothing will reach the ledger.
        row({
          refundId: refundId(4),
          state: 'failed',
          ledgerRecordedAt: null,
          creditNoteId: null,
          tax: money('500', 'ZZD'),
        }),
      ]),
    );
    mount();
    await screen.findAllByText('Waiting');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'State',
      'Seller ledger',
      'Tax',
      'Delivery part (incl. tax)',
      'Settled',
      'Actions',
    ]);
    const [recorded, waiting, pending, failed] = screen.getAllByRole('row').slice(1);
    // 2026-11-10 03:05 UTC is 1:05 pm in Brisbane.
    expect(within(recorded!).getByText('10 Nov, 1:05 pm')).toBeTruthy();
    expect(within(recorded!).getByText('$11.41')).toBeTruthy();
    expect(within(recorded!).getByText('$9.90')).toBeTruthy();
    const badge = within(waiting!).getByText('Waiting');
    expect(badge.closest('td')).not.toBeNull();
    expect(within(waiting!).getByText('None')).toBeTruthy();
    expect(within(pending!).getAllByText('Not yet')).toHaveLength(2);
    expect(within(failed!).getByText('None', { selector: 'span' })).toBeTruthy();
    expect(within(failed!).getByText(/5\.00/)).toBeTruthy();
    expect(within(failed!).queryByText('Waiting')).toBeNull();
  });

  it('shows the Stripe refund ID as text, and the words for none', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:refunds-columns',
      JSON.stringify(['stripeRefundId', 'creditNote', 'refundId', 'sellerOrderId']),
    );
    serve(() =>
      pageOf([
        row(),
        row({
          refundId: refundId(2),
          state: 'pending',
          stripeRefundId: null,
          creditNoteId: null,
        }),
        row({
          refundId: refundId(3),
          state: 'failed',
          stripeRefundId: null,
          creditNoteId: null,
        }),
      ]),
    );
    mount();
    await screen.findByText('re_3Pabc123');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'State',
      'Stripe refund ID',
      'Credit note',
      'Refund ID',
      'Seller order ID',
      'Actions',
    ]);
    const [done, pending, failed] = screen.getAllByRole('row').slice(1);
    expect(screen.getByText('re_3Pabc123').title).toBe('re_3Pabc123');
    expect(within(done!).getByText('000000E1').title).toBe('0190a000-0000-7000-8000-0000000000e1');
    expect(within(done!).getByText('000000F1').title).toBe(REFUND);
    expect(within(done!).getByText('000000D1').title).toBe('0190a000-0000-7000-8000-0000000000d1');
    expect(within(pending!).getByText('Not made yet')).toBeTruthy();
    expect(within(pending!).getByText('None')).toBeTruthy();
    expect(within(failed!).getAllByText('None')).toHaveLength(2);
    expect(within(failed!).queryByText('Not made yet')).toBeNull();
  });

  it('shows the id of the seller and the account where a name is missing, never raw text as HTML', async () => {
    serve(() => pageOf([row({ storeName: '<b>Evil</b>', customer: null })]));
    const { container } = mount();
    await screen.findByText('<b>Evil</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('000000C1').title).toBe(ACCOUNT);
    cleanup();
    serve(() => pageOf([row({ storeName: null })]));
    mount();
    expect((await screen.findByText('000000B1')).title).toBe(SELLER);
  });
});

describe('Refunds row actions', () => {
  const OPEN = (name: string) => screen.getByRole('button', { name });

  it('lists View order and Copy Stripe refund ID, as the row names them', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order', 'Copy Stripe refund ID']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View order' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ORDER}`);
  });

  it('offers only what the row names, ignores an unknown id, and has no menu without an action', async () => {
    serve(() =>
      pageOf([
        row({ actions: ['view-order', 'copy-tracking-reference', 'retry-refund'] }),
        row({ refundId: refundId(2), actions: [] }),
        row({ refundId: refundId(3), actions: ['mystery'] }),
      ]),
    );
    mount();
    await screen.findAllByText(STORE);
    expect(screen.getAllByRole('button', { name: /^Actions for order/ })).toHaveLength(1);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order']);
  });

  it('keeps a fixed menu order whatever the order of the row array', async () => {
    serve(() => pageOf([row({ actions: ['copy-stripe-reference', 'view-order'] })]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order', 'Copy Stripe refund ID']);
  });

  it('copies the Stripe refund ID and says Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Stripe refund ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('re_3Pabc123'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('says so when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy Stripe refund ID' }));
    expect(await screen.findByText("Couldn't copy. Select the text and copy it.")).toBeTruthy();
  });

  it('leaves out the copy item when the row names it but Stripe made no refund', async () => {
    serve(() => pageOf([row({ stripeRefundId: null })]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Copy Stripe refund ID' })).toBeNull();
  });
});

describe('Refunds selection and Bulk action', () => {
  it('offers "Select all N matching" after the page is ticked, and clears with the next list', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching refunds are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Refunded/ }));
    await waitFor(() => expect(screen.queryByText(/matching refunds are selected/)).toBeNull());
  });

  it('does not offer Select all matching when everything fits on the page', async () => {
    serve(() => pageOf([row()], { total: 1 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    expect(screen.queryByRole('button', { name: /Select all .* matching/ })).toBeNull();
  });
});

describe('Refunds states', () => {
  it('shows skeleton rows with a loading status on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading refunds...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("Refunds couldn't be loaded.")).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(STORE)).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('state=failed') ? 'fail' : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: /^Refused by Stripe/ }));
    expect(await screen.findByText("Refunds couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText(STORE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for order/ })).toBeNull();
  });

  it('goes to the sign-in page on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('says there is no access on a 403, with a link home', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText("You don't have access to refunds.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
  });

  it('treats validation.failed as "could not be loaded" and writes it once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'validation.failed',
        details: { fields: [{ path: 'q', code: 'format' }] },
      },
    } as never);
    mount();
    expect(await screen.findByText("Refunds couldn't be loaded.")).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it.each([
    ['all', 'No refunds yet', 'Refunds made from an order page show here.'],
    ['pending', 'Nothing waiting for Stripe', null],
    ['succeeded', 'No completed refunds', null],
    ['failed', 'No refused refunds', null],
  ] as const)('shows the %s tab empty state', async (tab, title, body) => {
    serve(() => pageOf([]));
    mount();
    await screen.findByText('No refunds yet');
    if (tab !== 'all') {
      const name = {
        pending: /^Waiting for Stripe/,
        succeeded: /^Refunded/,
        failed: /^Refused by Stripe/,
      }[tab];
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    if (body !== null) expect(screen.getByText(body)).toBeTruthy();
  });

  it('says nothing matches a filter, with Clear all to start again', async () => {
    serve((url) => (url.includes('reason=') ? pageOf([]) : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'reason' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'damaged' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('heading', { name: 'No refunds match' })).toBeTruthy();
    expect(screen.getByText('Try other filters or clear them.')).toBeTruthy();
    const clear = screen
      .getAllByRole('button', { name: 'Clear all' })
      .find((button) => button.closest('td') !== null)!;
    fireEvent.click(clear);
    expect(await screen.findByText(STORE)).toBeTruthy();
  });
});

describe('Refunds column choice', () => {
  const KEY = 'mp:admin:AU:acc-1:refunds-columns';

  it('keeps the choice in this browser, per Market and account, in the chosen order', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).getAllByText('Always shown')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tax' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Customer' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Tax up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([
      'amount',
      'reason',
      'actor',
      'store',
      'requested',
      'tax',
      'lossBearer',
    ]);
  });

  it('reads the choice back, and keys it by Market (second fixture ZZ)', async () => {
    window.localStorage.setItem('mp:admin:ZZ:acc-1:refunds-columns', JSON.stringify(['tax']));
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ' });
    await screen.findByText('$11.41');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'State',
      'Tax',
      'Actions',
    ]);
    cleanup();
    mount({ marketId: 'AU' });
    await screen.findByText(STORE);
    expect(screen.getAllByRole('columnheader')).toHaveLength(11);
  });

  it('ignores a stored column that no longer exists, and puts the defaults back with Reset', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['gone', 'tax', 'tax']));
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('$11.41');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'State',
      'Tax',
      'Actions',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to default' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(11);
  });

  it('works when the browser storage refuses', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      serve(() => pageOf([row()]));
      mount();
      await screen.findByText(STORE);
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      const panel = await screen.findByRole('dialog', { name: 'Columns' });
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Tax' }));
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('columnheader', { name: 'Tax' })).toBeTruthy();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('cleans a stored choice to the exact column ids the export reads, without repeats', () => {
    expect(cleanColumns(undefined)).toEqual([
      'amount',
      'reason',
      'actor',
      'store',
      'customer',
      'requested',
      'lossBearer',
    ]);
    expect(cleanColumns(['x', 'tax', 'tax', 3])).toEqual(['tax']);
    expect(cleanColumns([])).toEqual([]);
    expect(
      cleanColumns([
        'amount',
        'reason',
        'actor',
        'store',
        'customer',
        'requested',
        'lossBearer',
        'ledger',
        'tax',
        'shipping',
        'settled',
        'stripeRefundId',
        'creditNote',
        'refundId',
        'sellerOrderId',
      ]),
    ).toHaveLength(15);
  });
});

describe('Refunds nav', () => {
  it('sits in Sales right after Shipments, with the wallet icon, and needs the order view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('refunds');
    expect(ids(['ordering.order.view'])).toContain('refunds');
    const sales = adminNav.items.filter((item) => item.group === 'sales').map((item) => item.id);
    expect(sales.slice(0, 3)).toEqual(['orders', 'shipments', 'refunds']);
    expect(adminNav.items.find((item) => item.id === 'refunds')).toMatchObject({
      icon: 'wallet',
      href: '/refunds',
      labelKey: 'nav.refunds',
      anyOf: ['ordering.order.view'],
    });
    expect(messages.nav.refunds).toBe('Refunds');
  });
});

describe('Refunds Export', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const bulk = () => screen.getByRole('button', { name: 'Bulk action' });
  const openExport = async () => {
    fireEvent.click(bulk());
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    return screen.findByRole('dialog');
  };
  const confirm = (dialog: HTMLElement, format: 'CSV' | 'XLSX' = 'CSV') => {
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(`^${format}`) }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };
  /** The export requests the page made, as path and query. */
  const fetched: string[] = [];
  const answerWith = (make: () => Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(make());
      }),
    );
  };
  const sent = () => {
    const url = new URL(fetched[fetched.length - 1]!, 'http://x');
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };
  const names: string[] = [];
  let click: { mockRestore: () => void };

  beforeEach(() => {
    fetched.length = 0;
    names.length = 0;
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
  });
  afterEach(() => click.mockRestore());

  it('has Export as the only item, and the button is off until a row is selected', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select order 00000001' })[0]!);
    expect(bulk()).toHaveProperty('disabled', false);
    fireEvent.click(bulk());
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['ExportCSV or XLSX, with the columns shown']);
    expect(fetched).toEqual([]);
  });

  it('sends the ticked ids, the shown columns in order, the zone and the list filter, and no paging', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:refunds-columns',
      JSON.stringify(['lossBearer', 'amount', 'store', 'stripeRefundId']),
    );
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount({ zone: LOS_ANGELES });
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: /^Refunded/ }));
    await waitFor(() => expect(lastUrl()).toContain('state=succeeded'));
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    answerWith(() => new Response('﻿Order ID\r\nrow 1\r\nrow 2\r\n', { status: 200 }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(sent()).toEqual({
      path: '/api/ordering/admin/refunds/export',
      params: {
        format: 'csv',
        state: 'succeeded',
        columns: 'lossBearer,amount,store,stripeRefundId',
        zone: LOS_ANGELES,
        ids: `${refundId(1)},${refundId(2)}`,
      },
    });
    expect(names).toEqual([expect.stringMatching(/^refunds-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  it('sends no ids after "Select all matching", takes the file name from the server and counts the total', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount({ paging: 'pages' });
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            'content-type': XLSX,
            'content-disposition': 'attachment; filename="refunds-2026-11-17.xlsx"',
          },
        }),
    );
    confirm(await openExport(), 'XLSX');
    expect(await screen.findByText('Exported 143 rows.')).toBeTruthy();
    const { params } = sent();
    expect(params['format']).toBe('xlsx');
    expect(params).not.toHaveProperty('ids');
    expect(params).not.toHaveProperty('page');
    expect(params).not.toHaveProperty('pageSize');
    expect(params).not.toHaveProperty('sort');
    expect(params).not.toHaveProperty('direction');
    expect(names).toEqual(['refunds-2026-11-17.xlsx']);
  });

  it('leaves out page, cursor and limit with Previous and next, and counts the rows of a CSV with a line break inside a cell', async () => {
    serve(() => cursorPage([row()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    answerWith(
      () => new Response('Order ID,Note\r\nr1,"two\r\nlines"\r\nr2,x\r\n', { status: 200 }),
    );
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    const { params } = sent();
    for (const key of ['ids', 'page', 'pageSize', 'sort', 'direction', 'cursor', 'limit']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it('says so when there are too many rows', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    answerWith(
      () =>
        new Response(
          '{"statusCode":413,"code":"batch.too-large","details":{"max":10000,"total":12345}}',
          { status: 413 },
        ),
    );
    confirm(await openExport());
    expect(
      await screen.findByText(
        'Too many rows to export: 12,345 match, and one file holds up to 10,000. Narrow the filter or select fewer rows.',
      ),
    ).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('asks to narrow a search that is too broad', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    answerWith(
      () =>
        new Response(
          '{"statusCode":400,"code":"validation.failed","details":{"fields":[{"path":"search","code":"too-broad"}]}}',
          { status: 400 },
        ),
    );
    confirm(await openExport());
    expect(
      await screen.findByText(
        'This search is too broad to export. Narrow the search and try again.',
      ),
    ).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('says so when the export fails or the connection breaks', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    answerWith(() => new Response('{"code":"access.unavailable"}', { status: 503 }));
    confirm(await openExport());
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    toast.dismiss();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network'))),
    );
    confirm(await openExport());
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('says so when the download is cut off mid-stream', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all refunds on this page' }));
    answerWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('network'));
            },
          }),
          { status: 200 },
        ),
    );
    confirm(await openExport());
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('closes the dialog without a request when it is cancelled', async () => {
    serve(() => pageOf([row(), row({ refundId: refundId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select order 00000001' })[0]!);
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetched).toEqual([]);
  });
});
