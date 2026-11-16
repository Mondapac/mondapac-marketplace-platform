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
import { ShipmentsList } from './shipments-list.tsx';
import { cleanColumns } from './shipments-columns.ts';
import type { ShipmentRow, ShipmentsPage } from './shipments-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
const LOS_ANGELES = 'America/Los_Angeles';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane, still the 16th in Los Angeles.
const NOW = new Date('2026-11-16T20:30:00.000Z');

const ORDER = '0190a000-0000-7000-8000-000000000001';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const ACCOUNT = '0190a000-0000-7000-8000-0000000000c1';
const cursor = (n: number) => `${1763300000000 + n}.0190a000-0000-7000-8000-0000000000a${n}`;
const money = (amount: string, currency = 'AUD') => ({ amount, currency });

const row = (over: Partial<ShipmentRow> = {}): ShipmentRow => ({
  sellerOrderId: '0190a000-0000-7000-8000-0000000000d1',
  orderId: ORDER,
  sellerId: SELLER,
  storeName: 'Cedar Lane Halal Meats',
  accountId: ACCOUNT,
  customer: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
  paidAt: '2026-11-10T01:30:00.000Z',
  deliveryMethod: 'same_day',
  deliveryWindow: null,
  stage: 'shipped',
  fulfilment: 'shipped',
  readyAt: '2026-11-10T03:00:00.000Z',
  shippedAt: '2026-11-10T05:00:00.000Z',
  deliveredAt: null,
  carrier: 'Swift Couriers',
  trackingRef: 'SC 4471 99',
  fleet: 'swift',
  deliveryAttention: null,
  shipping: money('990'),
  total: money('12550'),
  refunded: money('0'),
  actions: ['view-order', 'copy-tracking-reference'],
  ...over,
});
const COUNTS = { toPrepare: 5, ready: 4, shipped: 3, delivered: 2, refunded: 1, attention: 7 };
const pageOf = (shipments: ShipmentRow[], over: Partial<ShipmentsPage> = {}): ShipmentsPage => ({
  shipments,
  counts: COUNTS,
  total: shipments.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  searchCapped: false,
  searchScope: null,
  ...over,
});
/** The answer of Previous and next: no total, no page. */
const cursorPage = (shipments: ShipmentRow[], nextCursor: string | null = null) =>
  pageOf(shipments, { total: null, page: null, nextCursor });

type Answer = ShipmentsPage | 'fail' | 'denied' | 'unauthenticated' | 'search-down';

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
      <ShipmentsList
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

describe('Shipments page numbers', () => {
  it('asks for page 1, Paid newest first, and shows the header, tabs and sorted line', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    expect(await screen.findByRole('link', { name: /Order 000000D1|Order 00000001/ })).toBeTruthy();
    expect(urls()[0]).toBe('ordering/admin/shipments?page=1&pageSize=25&sort=paid&direction=desc');
    expect(screen.getByText(/One row for each seller in each paid order\./)).toBeTruthy();
    expect(screen.getByText('Times and days are in Australia/Brisbane.')).toBeTruthy();
    expect(screen.getByText('Sorted by Paid: Newest first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy();
    expect(screen.getByText('1 to 1 of 143')).toBeTruthy();
    // Read only: no Add or Import, and the saved filter UI is hidden.
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save filter/ })).toBeNull();
  });

  it('shows the tab counts: All is the sum of the stages, Needs attention its own count', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(screen.getByRole('button', { name: 'All (15)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    for (const name of [
      'Needs attention (7)',
      'To prepare (5)',
      'Ready (4)',
      'Shipped (3)',
      'Delivered (2)',
      'Refunded (1)',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Refunded (1)' }).getAttribute('title')).toMatch(
      /Refunded in full before shipping/,
    );
  });

  it('sends attention=any for Needs attention and the stage for a stage tab, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['attention']).toBe('any'));
    expect(paramsOf(lastUrl())).toMatchObject({ page: '1' });
    expect(paramsOf(lastUrl())).not.toHaveProperty('stage');
    fireEvent.click(screen.getByRole('button', { name: /^To prepare/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['stage']).toBe('to-prepare'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('attention');
  });

  it('sorts by Total, highest first, and then lowest first', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Total' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=desc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=total&direction=asc'));
    expect(screen.getByText('Sorted by Total: Lowest first')).toBeTruthy();
  });

  it('stops page numbers at row 10,000, with the banner, and sends no page past 400', async () => {
    serve((url) => pageOf([row()], { total: 12_345, page: Number(paramsOf(url)['page']) }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(
      screen.getByText(/Page numbers stop at the first 10,000 shipments\. Narrow the filters/),
    ).toBeTruthy();
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 400' }));
    await waitFor(() => expect(lastUrl()).toContain('page=400'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true),
    );
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
    // The footer's own "narrow" notice would repeat the banner: only the banner shows.
    expect(screen.queryByText('Narrow the list to see more.')).toBeNull();
  });

  it('offers one page size only and no rows-per-page choice beyond it', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const picker = screen.getByLabelText('Rows per page');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['25']);
  });

  it('goes back to the last page that has rows when the page asked for is empty', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '2'
        ? // The second page emptied while the admin was on the first one.
          pageOf([], { total: 25, page: 2 })
        : pageOf([row()], { total: 30, page: 1 }),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(urls().some((url) => url.includes('page=2'))).toBe(true));
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Shipments Previous and next', () => {
  it('sends the limit alone, hides Sort, says Newest first and shows no total', async () => {
    serve(() => cursorPage([row()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    expect(urls()[0]).toBe('ordering/admin/shipments?limit=25');
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    expect(screen.getByText('Newest first')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    // The tab counts still show.
    expect(screen.getByRole('button', { name: 'All (15)' })).toBeTruthy();
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
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Second Store');
    expect(lastUrl()).toBe(
      `ordering/admin/shipments?limit=25&cursor=${encodeURIComponent(cursor(1))}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Third Store');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Second Store');
    expect(lastUrl()).toContain(`cursor=${encodeURIComponent(cursor(1))}`);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('First Store');
    expect(lastUrl()).toBe('ordering/admin/shipments?limit=25');
    for (const url of urls()) {
      for (const key of ['page', 'pageSize', 'sort', 'direction']) {
        expect(paramsOf(url)).not.toHaveProperty(key);
      }
    }
  });

  it('starts again from the first cursor when a tab or a filter changes', async () => {
    serve((url) =>
      paramsOf(url)['cursor'] === undefined
        ? cursorPage([row()], cursor(1))
        : cursorPage([row()], null),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('cursor='));
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    await waitFor(() => expect(lastUrl()).toBe('ordering/admin/shipments?stage=shipped&limit=25'));
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
  });

  it('shows no match count with the chips, and offers "Select all matching" without a number', async () => {
    serve(() => cursorPage([row()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shipments on this page' }));
    expect(screen.getByRole('button', { name: 'Select all matching' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching shipments are selected')).toBeTruthy();
  });
});

describe('Shipments search', () => {
  const ID = '0190a000-0000-7000-8000-0000000000e5';
  const box = () => screen.getByRole('searchbox', { name: 'Search' });

  it('sends a UUID as q on Enter, and a name as search after the typing pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: ` ${ID} ` } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
    expect(paramsOf(lastUrl())).not.toHaveProperty('search');
    expect(screen.getByText(`Search: "${ID}"`)).toBeTruthy();

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
    await screen.findByText('Cedar Lane Halal Meats');
    const before = urls().length;
    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    expect(urls()).toHaveLength(before);
    expect(screen.queryByText(/^Search: /)).toBeNull();
    // A second character asks, and the hint goes.
    fireEvent.change(box(), { target: { value: 'ab' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('ab'));
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
  });

  it('sends the tracking scope as q as typed, even one character, and words its chip', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(screen.getByLabelText('Search by'), { target: { value: 'tracking' } });
    expect(box().getAttribute('placeholder')).toBe('Tracking reference, exact');
    fireEvent.change(box(), { target: { value: ' SC 4471 99 ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('SC 4471 99'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('search');
    expect(screen.getByText('Tracking: "SC 4471 99"')).toBeTruthy();
    fireEvent.change(box(), { target: { value: '7' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('7'));
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
  });

  it('drops a one-character search when the scope changes to one that needs two', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(screen.getByLabelText('Search by'), { target: { value: 'tracking' } });
    fireEvent.change(box(), { target: { value: '7' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('7'));
    fireEvent.change(screen.getByLabelText('Search by'), { target: { value: 'name' } });
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
    expect(screen.queryByText(/^Tracking: /)).toBeNull();
  });

  it('removes the search with its chip and clears the box', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText('Search: "Cedar"');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('search'));
    expect((box() as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Search: "Cedar"')).toBeNull();
  });

  it('says when only store names were searched, and when the search was capped', async () => {
    serve((url) =>
      url.includes('search=')
        ? pageOf([row()], { searchScope: 'stores', searchCapped: true })
        : pageOf([row()]),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(screen.queryByText(/Only store names were searched/)).toBeNull();
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/Only store names were searched\./)).toBeTruthy();
    expect(screen.getByText(/More than 200 customers or stores match/)).toBeTruthy();
  });

  it('replaces the table with a critical banner when name search is down, keeping chips and counts', async () => {
    serve((url) => (url.includes('search=') ? 'search-down' : pageOf([row()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(
      await screen.findByText("Name search isn't available right now. Try again, or search by ID."),
    ).toBeTruthy();
    expect(screen.queryByText('Cedar Lane Halal Meats')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Search: "Cedar"')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All (15)' })).toBeTruthy();
    // Try again asks the same again; removing the chip gets the list back.
    const before = urls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(urls().length).toBe(before + 1));
    expect(lastUrl()).toContain('search=Cedar');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Shipments filters', () => {
  async function applyFilter(field: string, value: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: field } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('filters by delivery method and problem, as chips that can be removed', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), {
      target: { value: 'deliveryMethod' },
    });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Value', 'Pickup', 'Instant delivery', 'Same-day delivery', 'Scheduled delivery']);
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'pickup' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(panel).getAllByLabelText('Field')[1]!, {
      target: { value: 'attention' },
    });
    fireEvent.change(within(panel).getAllByLabelText('Value')[1]!, {
      target: { value: 'no-carrier' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['deliveryMethod']).toBe('pickup'));
    expect(paramsOf(lastUrl())['attention']).toBe('no-carrier');
    expect(screen.getByText('Delivery method is Pickup')).toBeTruthy();
    expect(screen.getByText('Delivery problem is No courier found')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (2)' })).toBeTruthy();
    expect(screen.getByText('1 shipment matches')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Delivery method is Pickup' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('deliveryMethod'));
    expect(paramsOf(lastUrl())['attention']).toBe('no-carrier');
  });

  it('offers no Any problem choice on the Needs attention tab, and keeps it elsewhere', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const problemOptions = async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
      const panel = await screen.findByRole('dialog', { name: 'Filter' });
      fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'attention' } });
      const names = within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent);
      fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
      return names;
    };
    expect(await problemOptions()).toContain('Any problem');
    fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['attention']).toBe('any'));
    expect(await problemOptions()).not.toContain('Any problem');
  });

  it('drops an Any problem chip when the Needs attention tab opens, since the tab says it', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('attention', 'any');
    await screen.findByText('Delivery problem is Any problem');
    fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
    await waitFor(() => expect(screen.queryByText('Delivery problem is Any problem')).toBeNull());
    expect(paramsOf(lastUrl())['attention']).toBe('any');
  });

  it('reads Paid and Shipped presets on the clock of the list zone, Brisbane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount({ zone: BRISBANE });
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('paid', 'today');
    await waitFor(() => expect(paramsOf(lastUrl())['paidFrom']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      paidFrom: '2026-11-16T14:00:00.000Z',
      paidTo: '2026-11-17T14:00:00.000Z',
    });
    expect(screen.getByText('Paid is Today')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(panel).getAllByLabelText('Field')[1]!, {
      target: { value: 'shipped' },
    });
    fireEvent.change(within(panel).getAllByLabelText('Value')[1]!, {
      target: { value: 'last-month' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['shippedFrom']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      shippedFrom: '2026-09-30T14:00:00.000Z',
      shippedTo: '2026-10-31T14:00:00.000Z',
    });
  });

  it('reads the same preset on another zone, Los Angeles, at the same instant', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('paid', 'today');
    await waitFor(() => expect(paramsOf(lastUrl())['paidFrom']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      paidFrom: '2026-11-16T08:00:00.000Z',
      paidTo: '2026-11-17T08:00:00.000Z',
    });
  });

  it('shows a removable Seller chip when a link names one, with the store name or the short id', async () => {
    serve((url) =>
      url.includes('sellerId=') ? pageOf([row()]) : pageOf([row({ storeName: 'Other Store' })]),
    );
    mount({ sellerId: SELLER });
    await screen.findByText('Seller is Cedar Lane Halal Meats');
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Seller is Cedar Lane Halal Meats' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
  });

  it('names the seller by its short id when no row knows the store', async () => {
    serve(() =>
      pageOf([row({ storeName: null, sellerId: '0190a000-0000-7000-8000-0000000000b1' })]),
    );
    mount({ sellerId: SELLER });
    expect(await screen.findByText('Seller is 000000B1')).toBeTruthy();
  });

  it('clears the search, filters and seller together with Clear all, keeping the tab', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText('Seller is Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    await applyFilter('deliveryMethod', 'instant');
    await screen.findByText('Delivery method is Instant delivery');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('deliveryMethod'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId');
    expect(paramsOf(lastUrl())['stage']).toBe('shipped');
  });
});

describe('Shipments rows', () => {
  it('shows the default columns with money in the row currency (two currencies) and times in the zone', async () => {
    serve(() =>
      pageOf([
        row(),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d2',
          storeName: 'Zed Store',
          total: money('48000', 'ZZD'),
        }),
      ]),
    );
    mount();
    await screen.findByText('Zed Store');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'Stage',
      'Store',
      'Customer',
      'Paid',
      'Delivery',
      'Carrier and tracking',
      'Total (incl. tax)',
      'Actions',
    ]);
    const first = screen.getAllByRole('row')[1]!;
    expect(within(first).getByText('$125.50')).toBeTruthy();
    // 2026-11-10 01:30 UTC is 11:30 am in Brisbane.
    expect(within(first).getByText('10 Nov, 11:30 am')).toBeTruthy();
    expect(within(first).getByText('Same-day delivery')).toBeTruthy();
    expect(within(first).getByText('Swift Couriers')).toBeTruthy();
    expect(within(first).getByText('SC 4471 99')).toBeTruthy();
    expect(within(first).getByText('Ada Lovelace')).toBeTruthy();
    const second = screen.getAllByRole('row')[2]!;
    expect(within(second).getByText(/480\.00/)).toBeTruthy();
    expect(within(second).queryByText('$480.00')).toBeNull();
    // The reference links to the order, with the full id as its title.
    const link = within(first).getByRole('link', { name: 'Order 00000001' });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER}`);
    expect(link.getAttribute('title')).toBe(ORDER);
  });

  it('shows the same times on another zone (Los Angeles)', async () => {
    serve(() => pageOf([row()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText('Cedar Lane Halal Meats');
    // 2026-11-10 01:30 UTC is 9 Nov 5:30 pm in Los Angeles.
    expect(screen.getByText('9 Nov, 5:30 pm')).toBeTruthy();
    expect(screen.getByText('Times and days are in America/Los_Angeles.')).toBeTruthy();
  });

  it('shows the stage badge, and under it the delivery problem with its long text as the title', async () => {
    serve(() =>
      pageOf([
        row({ stage: 'to-prepare', fulfilment: 'to-ship', deliveryAttention: 'no-carrier' }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d2',
          stage: 'delivered',
          deliveryAttention: 'carrier-unknown',
        }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d3',
          stage: 'refunded',
          deliveryAttention: 'cancel-unknown',
        }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    const body = screen.getAllByRole('row').slice(1);
    expect(within(body[0]!).getByText('To prepare')).toBeTruthy();
    const problem = within(body[0]!).getByText('No courier found');
    expect(problem.closest('[title]')?.getAttribute('title')).toBe(
      messages.orders.detail.attention['no-carrier'],
    );
    expect(problem.querySelector('svg')).not.toBeNull();
    expect(within(body[1]!).getByText('Courier booking unclear')).toBeTruthy();
    expect(within(body[2]!).getByText('Cancellation not confirmed')).toBeTruthy();
  });

  it('shows the carrier column words: pickup, not shipped yet, not recorded', async () => {
    serve(() =>
      pageOf([
        row({
          deliveryMethod: 'pickup',
          carrier: null,
          trackingRef: null,
          actions: ['view-order'],
        }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d2',
          stage: 'to-prepare',
          fulfilment: 'to-ship',
          carrier: null,
          trackingRef: null,
        }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d3',
          carrier: null,
          trackingRef: null,
        }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    expect(screen.getByText('Pickup', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Not shipped yet')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('shows the window of a scheduled delivery under the method', async () => {
    serve(() =>
      pageOf([
        row({
          deliveryMethod: 'scheduled',
          deliveryWindow: { start: '2026-11-12T04:00:00.000Z', end: '2026-11-12T06:00:00.000Z' },
        }),
      ]),
    );
    mount();
    await screen.findByText('Scheduled delivery');
    // 04:00 UTC is 2:00 pm in Brisbane; the end shares the day, so only its time follows.
    expect(screen.getByText('12 Nov, 2:00 pm to 4:00 pm')).toBeTruthy();
  });

  it('shows the optional columns with their empty words, and money including a zero amount', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:shipments-columns',
      JSON.stringify(['ready', 'shipped', 'delivered', 'fleet', 'fee', 'refunded', 'seller-order']),
    );
    serve(() =>
      pageOf([
        row({
          readyAt: null,
          shippedAt: null,
          deliveredAt: null,
          fleet: null,
          shipping: money('0'),
          refunded: money('0'),
        }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d2',
          fleet: 'swift',
          shipping: money('990', 'ZZD'),
          refunded: money('2500', 'ZZD'),
        }),
      ]),
    );
    mount();
    await screen.findAllByText('Not yet');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'Stage',
      'Ready',
      'Shipped',
      'Delivered',
      'Fleet',
      'Delivery fee (incl. tax)',
      'Refunded (incl. tax)',
      'Seller order ID',
      'Actions',
    ]);
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first!).getAllByText('Not yet')).toHaveLength(3);
    expect(within(first!).getByText('Not recorded')).toBeTruthy();
    expect(within(first!).getByText('$0.00')).toBeTruthy();
    expect(within(first!).getByText('None')).toBeTruthy();
    expect(within(second!).getByText('swift')).toBeTruthy();
    expect(within(second!).getByText(/9\.90/)).toBeTruthy();
    expect(within(second!).getByText(/25\.00/)).toBeTruthy();
    expect(within(first!).getByText('000000D1').title).toBe('0190a000-0000-7000-8000-0000000000d1');
  });

  it('shows the id of the seller and the account where a name is missing, never raw text as HTML', async () => {
    serve(() =>
      pageOf([row({ storeName: null, customer: null, carrier: '<b>Evil</b>', trackingRef: null })]),
    );
    const { container } = mount();
    await screen.findByText('<b>Evil</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('000000B1').title).toBe(SELLER);
    expect(screen.getByText('000000C1').title).toBe(ACCOUNT);
  });
});

describe('Shipments row actions', () => {
  const OPEN = (name: string) => screen.getByRole('button', { name });

  it('lists View order and Copy tracking reference, as the row names them', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order', 'Copy tracking reference']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View order' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ORDER}`);
  });

  it('offers only what the row names, ignores an unknown id, and has no menu without an action', async () => {
    serve(() =>
      pageOf([
        row({ actions: ['view-order', 'download-order-document', 'copy-stripe-reference'] }),
        row({ sellerOrderId: '0190a000-0000-7000-8000-0000000000d2', actions: [] }),
        row({
          sellerOrderId: '0190a000-0000-7000-8000-0000000000d3',
          actions: ['mystery'],
        }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    expect(screen.getAllByRole('button', { name: /^Actions for order/ })).toHaveLength(1);
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order']);
  });

  it('copies the tracking reference and says Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy tracking reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SC 4471 99'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('says so when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      configurable: true,
    });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy tracking reference' }));
    expect(await screen.findByText("Couldn't copy. Select the text and copy it.")).toBeTruthy();
  });

  it('leaves out the copy item when the row names it but holds no reference', async () => {
    serve(() => pageOf([row({ trackingRef: null })]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Copy tracking reference' })).toBeNull();
  });
});

describe('Shipments selection and Bulk action', () => {
  it('disables Bulk action with nothing selected, and keeps it without a menu while rows are ticked', async () => {
    serve(() => pageOf([row(), row({ sellerOrderId: '0190a000-0000-7000-8000-0000000000d2' })]));
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk).toHaveProperty('disabled', true);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select order 00000001' })[0]!);
    expect(screen.getByText('1 shipment selected')).toBeTruthy();
    // There is no Export yet, so there is no action to open: the button stays disabled.
    expect(screen.getByRole('button', { name: 'Bulk action' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Bulk action' }).getAttribute('title')).toBe(
      'No bulk actions are available for shipments yet.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('1 shipment selected')).toBeNull();
  });

  it('offers "Select all N matching" after the page is ticked, and clears with the next list', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shipments on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching shipments are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    await waitFor(() => expect(screen.queryByText(/matching shipments are selected/)).toBeNull());
  });

  it('does not offer Select all matching when everything fits on the page', async () => {
    serve(() => pageOf([row()], { total: 1 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all shipments on this page' }));
    expect(screen.queryByRole('button', { name: /Select all .* matching/ })).toBeNull();
  });
});

describe('Shipments states', () => {
  it('shows skeleton rows with a loading status on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading shipments...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("Shipments couldn't be loaded.")).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('stage=shipped') ? 'fail' : pageOf([row()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Shipped/ }));
    expect(await screen.findByText("Shipments couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText('Cedar Lane Halal Meats')).toBeTruthy();
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
    expect(await screen.findByText("You don't have access to shipments.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
  });

  it.each([
    ['all', 'No shipments yet', 'Paid orders show here, one row for each seller.'],
    ['attention', 'Nothing needs attention', 'Deliveries with a courier problem show here.'],
    ['to-prepare', 'Nothing to prepare', null],
    ['ready', 'Nothing waiting for pickup by a courier', null],
    ['shipped', 'Nothing on the way', null],
    ['delivered', 'Nothing delivered yet', null],
    [
      'refunded',
      'No cancelled shipments',
      'Seller orders refunded in full before shipping show here.',
    ],
  ] as const)('shows the %s tab empty state', async (tab, title, body) => {
    serve(() => pageOf([], { counts: { ...COUNTS } }));
    mount();
    await screen.findByText('No shipments yet');
    if (tab !== 'all') {
      const name = {
        attention: /^Needs attention/,
        'to-prepare': /^To prepare/,
        ready: /^Ready/,
        shipped: /^Shipped/,
        delivered: /^Delivered/,
        refunded: /^Refunded/,
      }[tab];
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
    if (body !== null) expect(screen.getByText(body)).toBeTruthy();
  });

  it('says nothing matches a filter, with Clear all to start again', async () => {
    serve((url) => (url.includes('deliveryMethod=') ? pageOf([]) : pageOf([row()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), {
      target: { value: 'deliveryMethod' },
    });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'pickup' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('heading', { name: 'No shipments match' })).toBeTruthy();
    expect(screen.getByText('Try other filters or clear them.')).toBeTruthy();
    const clear = screen
      .getAllByRole('button', { name: 'Clear all' })
      .find((button) => button.closest('td') !== null)!;
    fireEvent.click(clear);
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Shipments column choice', () => {
  const KEY = 'mp:admin:AU:acc-1:shipments-columns';

  it('keeps the choice in this browser, per Market and account, in the chosen order', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    // Order and Stage are fixed and listed as always shown.
    expect(within(panel).getByText('Order')).toBeTruthy();
    expect(within(panel).getAllByText('Always shown')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Fleet' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Customer' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Fleet up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([
      'store',
      'paid',
      'delivery',
      'carrier',
      'fleet',
      'total',
    ]);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'Stage',
      'Store',
      'Paid',
      'Delivery',
      'Carrier and tracking',
      'Fleet',
      'Total (incl. tax)',
      'Actions',
    ]);
  });

  it('reads the choice back, and keys it by Market (second fixture ZZ)', async () => {
    window.localStorage.setItem('mp:admin:ZZ:acc-1:shipments-columns', JSON.stringify(['fleet']));
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ' });
    await screen.findByText('swift');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'Stage',
      'Fleet',
      'Actions',
    ]);
    cleanup();
    mount({ marketId: 'AU' });
    await screen.findByText('Cedar Lane Halal Meats');
    expect(screen.getAllByRole('columnheader')).toHaveLength(10);
  });

  it('ignores a stored column that no longer exists, and puts the defaults back with Reset', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['gone', 'fleet', 'fleet']));
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText('swift');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Order',
      'Stage',
      'Fleet',
      'Actions',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to default' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('columnheader')).toHaveLength(10);
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
      await screen.findByText('Cedar Lane Halal Meats');
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      const panel = await screen.findByRole('dialog', { name: 'Columns' });
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Fleet' }));
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('columnheader', { name: 'Fleet' })).toBeTruthy();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('cleans a stored choice to known columns without repeats', () => {
    expect(cleanColumns(undefined)).toEqual([
      'store',
      'customer',
      'paid',
      'delivery',
      'carrier',
      'total',
    ]);
    expect(cleanColumns(['x', 'fleet', 'fleet', 3])).toEqual(['fleet']);
    expect(cleanColumns([])).toEqual([]);
  });
});

describe('Shipments nav', () => {
  it('sits in Sales right after Orders, with the package icon, and needs the order view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('shipments');
    expect(ids(['ordering.order.view'])).toContain('shipments');
    const sales = adminNav.items.filter((item) => item.group === 'sales').map((item) => item.id);
    // Refunds follows; a Transactions item will go between the two later.
    expect(sales.slice(0, 2)).toEqual(['orders', 'shipments']);
    expect(adminNav.items.find((item) => item.id === 'shipments')).toMatchObject({
      icon: 'package',
      href: '/shipments',
      labelKey: 'nav.shipments',
      anyOf: ['ordering.order.view'],
    });
    expect(messages.nav.shipments).toBe('Shipments');
  });
});
