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
import { InvoicesList } from './invoices-list.tsx';
import { OPTIONAL_COLUMNS, cleanColumns } from './invoices-columns.ts';
import type { DocumentRow, DocumentsPage } from './invoices-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
const LOS_ANGELES = 'America/Los_Angeles';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane, still the 16th in Los Angeles.
const NOW = new Date('2026-11-16T20:30:00.000Z');

const ORDER = '0190a000-0000-7000-8000-000000000001';
const SELLER = '0190a000-0000-7000-8000-0000000000b1';
const ACCOUNT = '0190a000-0000-7000-8000-0000000000c1';
const SELLER_ORDER = '0190a000-0000-7000-8000-0000000000d1';
const cursor = (n: number) => `${1763300000000 + n}.0190a000-0000-7000-8000-0000000000a${n}`;
const money = (amount: string, currency = 'AUD') => ({ amount, currency });

const confirmation = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  kind: 'order-confirmation',
  documentId: SELLER_ORDER,
  documentNumber: null,
  orderId: ORDER,
  sellerOrderId: SELLER_ORDER,
  sellerId: SELLER,
  storeName: 'Cedar Lane Halal Meats',
  accountId: ACCOUNT,
  customer: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
  issuedAt: '2026-11-10T01:30:00.000Z',
  total: money('12550'),
  tax: money('1141'),
  shipping: money('990'),
  refundId: null,
  refundReason: null,
  actions: ['view-order', 'download-order-document'],
  ...over,
});
const CREDIT_ID = '0190a000-0000-7000-8000-0000000000e1';
const REFUND_ID = '0190a000-0000-7000-8000-0000000000f1';
const creditNote = (over: Partial<DocumentRow> = {}): DocumentRow =>
  confirmation({
    kind: 'credit-note',
    documentId: CREDIT_ID,
    refundId: REFUND_ID,
    refundReason: 'damaged',
    total: money('4000'),
    tax: money('364'),
    shipping: money('0'),
    actions: ['view-order'],
    ...over,
  });
const COUNTS = { orderConfirmations: 12, creditNotes: 3 };
const pageOf = (documents: DocumentRow[], over: Partial<DocumentsPage> = {}): DocumentsPage => ({
  documents,
  counts: COUNTS,
  total: documents.length,
  page: 1,
  pageSize: 25,
  nextCursor: null,
  searchCapped: false,
  searchScope: null,
  ...over,
});
/** The answer of Previous and next: no total, no page. */
const cursorPage = (documents: DocumentRow[], nextCursor: string | null = null) =>
  pageOf(documents, { total: null, page: null, nextCursor });

type SavedRoute = (method: string, path: string, body: unknown, csrf?: string) => Promise<never>;
/** Until a test says otherwise the saved-filter route is not there: the controls stay hidden. */
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } } as never);

type Answer = DocumentsPage | 'fail' | 'denied' | 'unauthenticated' | 'search-down';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => Answer, saved: SavedRoute = noSavedRoute) {
  call.mockImplementation((method, path, body, csrf) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path, body, csrf);
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
/** Confirmations on the default tab, credit notes on the other. */
const byKind =
  (confirmations: DocumentRow[], notes: DocumentRow[], over: Partial<DocumentsPage> = {}) =>
  (url: string) =>
    pageOf(paramsOf(url)['kind'] === 'credit-note' ? notes : confirmations, over);
/** The list's own requests (the saved-filter routes have their own helper). */
const urls = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((url) => !url.startsWith('lists/admin/saved-filters'));
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent);

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    sellerId?: string | null;
    locale?: string;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale={options.locale ?? 'en-AU'} messages={messages}>
      <InvoicesList
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

describe('Invoices tabs and page numbers', () => {
  it('asks for order confirmations, page 1, Issued newest first, and shows the header and sorted line', async () => {
    serve(() => pageOf([confirmation()], { total: 143 }));
    mount();
    expect(await screen.findByRole('link', { name: 'Order 00000001' })).toBeTruthy();
    expect(urls()[0]).toBe(
      'ordering/admin/documents?kind=order-confirmation&page=1&pageSize=25&sort=issued&direction=desc',
    );
    expect(screen.getByText('These are not tax invoices.')).toBeTruthy();
    // The zone is no longer written on the page: it is in the Help panel, the account menu and the row times.
    expect(
      screen.queryByText(/(Times|Dates)( and days)?( are shown)?( are)? in [A-Z]/u),
    ).toBeNull();
    expect(screen.getByText('Sorted by Issued: Newest first')).toBeTruthy();
    expect(screen.getByText('1 to 1 of 143')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save filter/ })).toBeNull();
  });

  it('has two tabs with their own counts and no All tab', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(
      screen.getByRole('button', { name: 'Order confirmations (12)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Credit notes (3)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^All/ })).toBeNull();
  });

  it('sends kind=credit-note for the Credit notes tab, back on page 1', async () => {
    serve(() => pageOf([confirmation()], { total: 80 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('credit-note'));
    expect(paramsOf(lastUrl())).toMatchObject({ page: '1', sort: 'issued', direction: 'desc' });
  });

  it('keeps the search and the filter when the tab changes, and goes to page 1', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([confirmation()], { total: 80 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'Cedar' },
    });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search' }), { key: 'Enter' });
    await screen.findByText('Search: "Cedar"');
    await applyFilter();
    await screen.findByText('Issued is Last 7 days');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('credit-note'));
    expect(paramsOf(lastUrl())).toMatchObject({ search: 'Cedar', page: '1' });
    expect(paramsOf(lastUrl())['from']).toBeDefined();
    expect(screen.getByText('Search: "Cedar"')).toBeTruthy();
    expect(screen.getByText('Issued is Last 7 days')).toBeTruthy();
    // And back: the same again.
    fireEvent.click(screen.getByRole('button', { name: /^Order confirmations/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('order-confirmation'));
    expect(paramsOf(lastUrl())).toMatchObject({ search: 'Cedar', page: '1' });
  });

  async function applyFilter() {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'issued' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'last-7-days' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('sorts by Amount, highest first, and then lowest first', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=amount&direction=desc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=amount&direction=asc'));
    expect(screen.getByText('Sorted by Amount: Lowest first')).toBeTruthy();
  });

  it('stops page numbers at row 10,000, with the banner, and sends no page past 400', async () => {
    serve((url) =>
      pageOf([confirmation()], { total: 12_345, page: Number(paramsOf(url)['page']) }),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(
      screen.getByText(
        /Page numbers stop at the first 10,000 order confirmations\. Narrow the filters/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    // The banner sits above the table, with the other banners.
    const banner = screen.getByText(/Page numbers stop at the first 10,000 order confirmations/);
    expect(
      banner.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
        : pageOf([confirmation()], { total: 30, page: 1 }),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(urls().some((url) => url.includes('page=2'))).toBe(true));
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Invoices Previous and next', () => {
  it('sends kind and the limit alone, hides Sort, says Newest first and shows no total', async () => {
    serve(() => cursorPage([confirmation()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    expect(urls()[0]).toBe('ordering/admin/documents?kind=order-confirmation&limit=25');
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    expect(screen.getByText('Newest first')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Order confirmations (12)' })).toBeTruthy();
  });

  it('walks the cursor stack forward and back, never mixing a cursor with page or sort', async () => {
    serve((url) => {
      const sent = paramsOf(url)['cursor'];
      if (sent === undefined)
        return cursorPage([confirmation({ storeName: 'First Store' })], cursor(1));
      if (sent === cursor(1))
        return cursorPage([confirmation({ storeName: 'Second Store' })], cursor(2));
      return cursorPage([confirmation({ storeName: 'Third Store' })], null);
    });
    mount({ paging: 'prev-next' });
    await screen.findByText('First Store');
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Second Store');
    expect(lastUrl()).toBe(
      `ordering/admin/documents?kind=order-confirmation&limit=25&cursor=${encodeURIComponent(cursor(1))}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Third Store');
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Second Store');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('First Store');
    expect(lastUrl()).toBe('ordering/admin/documents?kind=order-confirmation&limit=25');
    for (const url of urls()) {
      for (const key of ['page', 'pageSize', 'sort', 'direction']) {
        expect(paramsOf(url)).not.toHaveProperty(key);
      }
    }
  });

  it('starts again from the first cursor when the tab changes', async () => {
    serve((url) =>
      paramsOf(url)['cursor'] === undefined
        ? cursorPage([confirmation()], cursor(1))
        : cursorPage([confirmation()], null),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('cursor='));
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() =>
      expect(lastUrl()).toBe('ordering/admin/documents?kind=credit-note&limit=25'),
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
  });

  it('offers "Select all matching" without a number', async () => {
    serve(() => cursorPage([confirmation()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching order confirmations are selected')).toBeTruthy();
  });
});

describe('Invoices search', () => {
  const ID = '0190a000-0000-7000-8000-0000000000e5';
  const box = () => screen.getByRole('searchbox', { name: 'Search' });

  it('has the placeholder of the spec, sends a UUID as q on Enter and a name as search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    expect(box().getAttribute('placeholder')).toBe(
      'Customer, store, or order, credit note or refund ID',
    );
    fireEvent.change(box(), { target: { value: ` ${ID} ` } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
    expect(paramsOf(lastUrl())).not.toHaveProperty('search');
    expect(screen.getByText(`Search: "${ID}"`)).toBeTruthy();

    fireEvent.change(box(), { target: { value: ' Cedar ' } });
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('Cedar'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('q');
  });

  it('sends a refund id such as re_123 as search text (only a UUID is an exact id here)', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 're_123' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('re_123'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('q');
  });

  it('sends an upper-case v7 id lower-cased, and a v4 UUID as search (the API knows v7 ids only)', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: ID.toUpperCase() } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
    const v4 = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
    fireEvent.change(box(), { target: { value: v4 } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe(v4));
    expect(paramsOf(lastUrl())).not.toHaveProperty('q');
  });

  it('shows the one-character hint only after Enter or leaving the box, not at the first keystroke', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 'a' } });
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
    fireEvent.blur(box());
    expect(screen.getByRole('status').textContent).toBe('Type at least 2 characters.');
    // Typing again takes it away until the box is left again.
    fireEvent.change(box(), { target: { value: 'b' } });
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
  });

  it('asks for nothing from one character and shows the hint under the box', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const before = urls().length;
    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    expect(urls()).toHaveLength(before);
    fireEvent.change(box(), { target: { value: 'ab' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['search']).toBe('ab'));
    expect(screen.queryByText('Type at least 2 characters.')).toBeNull();
  });

  it('removes the search with its chip and clears the box', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText('Search: "Cedar"');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('search'));
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('says when only store names were searched, and when the search was capped', async () => {
    serve(() => pageOf([confirmation()], { searchScope: 'stores', searchCapped: true }));
    mount();
    expect(
      await screen.findByText(/Only store names were searched\. Searching customer names needs/),
    ).toBeTruthy();
    expect(screen.getByText(/More than 200 customers or stores match/)).toBeTruthy();
  });

  it('replaces the table with a critical banner when name search is down, keeping chips and counts', async () => {
    serve((url) => (url.includes('search=') ? 'search-down' : pageOf([confirmation()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.change(box(), { target: { value: 'Cedar' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(
      await screen.findByText("Name search isn't available right now. Try again, or search by ID."),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Search: "Cedar"')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Order confirmations (12)' })).toBeTruthy();
    const before = urls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(urls().length).toBe(before + 1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Cedar"' }));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Invoices Issued filter', () => {
  async function applyFilter(value: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'issued' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('offers Issued only, with the date presets, and nothing for seller or amount', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const field = within(panel).getByLabelText('Field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((option) => option.textContent)
        .filter((text) => text !== 'Field'),
    ).toEqual(['Issued']);
    fireEvent.change(field, { target: { value: 'issued' } });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .filter((text) => text !== 'Value'),
    ).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'This month', 'Last month']);
  });

  it('reads the preset on the clock of the list zone, Brisbane, as a chip that can be removed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([confirmation()]));
    mount({ zone: BRISBANE });
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('today');
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
    expect(screen.getByText('Issued is Today')).toBeTruthy();
    expect(screen.getByText('1 order confirmation matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Issued is Today' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('from'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('to');
  });

  it('works on a Market that is not Australian: other locale, zone and currency', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() =>
      pageOf([
        confirmation({
          total: money('12550', 'EUR'),
          tax: money('2004', 'EUR'),
          shipping: money('990', 'EUR'),
        }),
      ]),
    );
    mount({ locale: 'de-DE', zone: 'Europe/Berlin', marketId: 'DE' });
    await screen.findByText('Cedar Lane Halal Meats');
    // The zone is no longer written on the page: it is in the Help panel, the account menu and the row times.
    expect(
      screen.queryByText(/(Times|Dates)( and days)?( are shown)?( are)? in [A-Z]/u),
    ).toBeNull();
    expect(screen.getByText(/125,50\s€/)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
    await applyFilter('today');
    // 16 Nov 20:30 UTC is 21:30 in Berlin (UTC+1): today runs from 23:00 UTC on the 15th.
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-15T23:00:00.000Z',
      to: '2026-11-16T23:00:00.000Z',
    });
  });

  it('shows a credit note with no tax and no reason in a non-Australian Market', async () => {
    serve(
      byKind(
        [confirmation()],
        [creditNote({ tax: null, refundReason: null, total: money('4000', 'EUR') })],
      ),
    );
    mount({ locale: 'de-DE', zone: 'Europe/Berlin', marketId: 'DE' });
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('credit-note'));
    expect(await screen.findByText(/40,00\s€/)).toBeTruthy();
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThanOrEqual(1);
  });

  it('reads the date presets at each load, so a tab left open past midnight moves on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([confirmation()]));
    mount({ zone: BRISBANE });
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('today');
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBe('2026-11-16T14:00:00.000Z'));
    // A day later, a new tab asks for the new day.
    vi.setSystemTime(new Date(NOW.getTime() + 24 * 3_600_000));
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('credit-note'));
    expect(paramsOf(lastUrl())['from']).toBe('2026-11-17T14:00:00.000Z');
  });

  it('reads the same preset on another zone, Los Angeles, at the same instant', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([confirmation()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText('Cedar Lane Halal Meats');
    await applyFilter('today');
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T08:00:00.000Z',
      to: '2026-11-17T08:00:00.000Z',
    });
  });

  it('shows a removable Seller chip when a link names one, with the store name or the short id', async () => {
    serve(() => pageOf([confirmation()]));
    mount({ sellerId: SELLER });
    await screen.findByText('Seller is Cedar Lane Halal Meats');
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Seller is Cedar Lane Halal Meats' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
    cleanup();
    serve(() => pageOf([confirmation({ storeName: null })]));
    mount({ sellerId: SELLER });
    expect(await screen.findByText('Seller is 000000B1')).toBeTruthy();
  });

  it('clears the search, filter and seller together with Clear all, keeping the tab', async () => {
    serve(() => pageOf([confirmation()]));
    mount({ sellerId: SELLER });
    await screen.findByText('Seller is Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await applyFilter('last-month');
    await screen.findByText('Issued is Last month');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('from'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId');
    expect(paramsOf(lastUrl())['kind']).toBe('credit-note');
  });
});

describe('Invoices rows', () => {
  it('shows the confirmation columns, money in two currencies and times in the zone', async () => {
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({
          documentId: '0190a000-0000-7000-8000-0000000000d2',
          storeName: 'Zed Store',
          total: money('48000', 'ZZD'),
          tax: money('4000', 'ZZD'),
        }),
      ]),
    );
    mount();
    await screen.findByText('Zed Store');
    // Reason exists for credit notes only, so a confirmation has no Reason column.
    expect(headers()).toEqual([
      '',
      'Order',
      'Issued',
      'Store',
      'Customer',
      'Total (incl. tax)',
      'Tax',
      'Actions',
    ]);
    const first = screen.getAllByRole('row')[1]!;
    expect(within(first).getByText('$125.50')).toBeTruthy();
    expect(within(first).getByText('$11.41')).toBeTruthy();
    // 2026-11-10 01:30 UTC is 11:30 am in Brisbane.
    expect(within(first).getByText('10 Nov, 11:30 am')).toBeTruthy();
    expect(within(first).getByText('Ada Lovelace')).toBeTruthy();
    const second = screen.getAllByRole('row')[2]!;
    expect(within(second).getByText(/480\.00/)).toBeTruthy();
    expect(within(second).getByText(/40\.00/)).toBeTruthy();
    expect(within(second).queryByText('$480.00')).toBeNull();
    const link = within(first).getByRole('link', { name: 'Order 00000001' });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER}`);
    expect(link.getAttribute('title')).toBe(ORDER);
  });

  it('shows the same times on another zone (Los Angeles)', async () => {
    serve(() => pageOf([confirmation()]));
    mount({ zone: LOS_ANGELES });
    await screen.findByText('Cedar Lane Halal Meats');
    expect(screen.getByText('9 Nov, 5:30 pm')).toBeTruthy();
  });

  it('says "Not recorded" for a tax that is null, with the reason as its title', async () => {
    serve(() => pageOf([confirmation({ tax: null })]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const word = screen.getByText('Not recorded');
    expect(word.closest('[title]')?.getAttribute('title')).toBe(
      'An item was placed before its tax was recorded.',
    );
  });

  it('shows the credit-note columns on the Credit notes tab, with the refund reason', async () => {
    serve(
      byKind(
        [confirmation()],
        [creditNote(), creditNote({ documentId: 'x1', refundReason: null })],
      ),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await screen.findByText('Damaged');
    expect(headers()).toEqual([
      '',
      'Order',
      'Issued',
      'Store',
      'Customer',
      'Total (incl. tax)',
      'Tax',
      'Reason',
      'Actions',
    ]);
    expect(screen.getAllByText('$40.00')).toHaveLength(2);
    // A credit note with no reason says so in words.
    expect(screen.getAllByText('Not recorded')).toHaveLength(1);
  });

  it('words an unknown refund reason as Other', async () => {
    serve(byKind([], [creditNote({ refundReason: 'mystery' })]));
    mount();
    await screen.findByText('No order confirmations yet');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    expect(await screen.findByText('Other')).toBeTruthy();
  });

  it('shows the optional columns: delivery with a zero amount, and the short ids', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:invoices-columns',
      JSON.stringify(['shipping', 'sellerOrderId', 'documentId', 'refundId']),
    );
    serve(byKind([confirmation()], [creditNote()]));
    mount();
    await screen.findByText('$9.90');
    // On the confirmations tab the credit-note-only columns are skipped.
    expect(headers()).toEqual(['', 'Order', 'Delivery (incl. tax)', 'Seller order ID', 'Actions']);
    expect(screen.getByText('000000D1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await screen.findByText('$0.00');
    expect(headers()).toEqual([
      '',
      'Order',
      'Delivery (incl. tax)',
      'Seller order ID',
      'Credit note ID',
      'Refund ID',
      'Actions',
    ]);
    expect(screen.getByText('000000E1')).toBeTruthy();
    expect(screen.getByText('000000F1')).toBeTruthy();
  });

  it('shows the id of the seller and the account where a name is missing, never raw text as HTML', async () => {
    serve(() =>
      pageOf([
        confirmation({ storeName: '<b>Bold</b>', customer: null }),
        confirmation({ documentId: 'x2', storeName: null }),
      ]),
    );
    mount();
    expect(await screen.findByText('<b>Bold</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getAllByText('000000B1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('000000C1').length).toBeGreaterThan(0);
  });

  it('never calls a row a tax invoice: only the intro says they are not', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:invoices-columns',
      JSON.stringify([...OPTIONAL_COLUMNS]),
    );
    serve(byKind([confirmation({ tax: null })], [creditNote()]));
    const { container } = mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const strip = (text: string) =>
      text.replace('These are not tax invoices.', '').replace(/\s+/g, ' ');
    expect(strip(container.textContent ?? '')).not.toMatch(/tax invoice/i);
    expect(container.textContent).toContain('These are not tax invoices.');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await screen.findByText('Damaged');
    expect(strip(container.textContent ?? '')).not.toMatch(/tax invoice/i);
    // No number column, and no row title or label says "invoice number".
    expect(headers().some((name) => /number|invoice/i.test(name ?? ''))).toBe(false);
    for (const element of container.querySelectorAll('[title],[aria-label]')) {
      expect(
        `${element.getAttribute('title') ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
      ).not.toMatch(/tax invoice/i);
    }
  });
});

describe('Invoices row actions', () => {
  const OPEN = (name: string) => screen.getByRole('button', { name });

  it('lists View order and Open order confirmation on a confirmation', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order', 'Open order confirmation']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'View order' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ORDER}`);
  });

  it('opens the printable order confirmation page of the order', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(OPEN('Actions for order 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open order confirmation' }));
    expect(push).toHaveBeenCalledWith(`/orders/${ORDER}/document`);
  });

  it('gives a credit note View order only', async () => {
    serve(byKind([], [creditNote()]));
    mount();
    await screen.findByText('No order confirmations yet');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await screen.findByText('Damaged');
    fireEvent.click(OPEN('Actions for order 00000001'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['View order']);
  });

  it('offers only what the row names, ignores an unknown id, and has no menu without an action', async () => {
    serve(() =>
      pageOf([
        confirmation({ actions: ['view-order', 'copy-tracking-reference'] }),
        confirmation({ documentId: 'x2', actions: [] }),
        confirmation({ documentId: 'x3', actions: ['mystery'] }),
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
});

describe('Invoices selection and Bulk action', () => {
  it('offers "Select all N matching" after the page is ticked, and drops it with the next tab', async () => {
    serve(() => pageOf([confirmation()], { total: 143 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching order confirmations are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() =>
      expect(screen.queryByText(/matching order confirmations are selected/)).toBeNull(),
    );
  });

  it('ticks two credit notes of one seller order independently (rows are keyed by document)', async () => {
    serve(
      byKind(
        [confirmation()],
        [creditNote(), creditNote({ documentId: '0190a000-0000-7000-8000-0000000000e2' })],
      ),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox', { name: /^Select order/ })).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByRole('checkbox', { name: /^Select order/ })[0]!);
    expect(screen.getByText('1 credit note selected')).toBeTruthy();
    expect(
      screen
        .getAllByRole('checkbox', { name: /^Select order/ })
        .map((box) => (box as HTMLInputElement).checked),
    ).toEqual([true, false]);
  });

  it('does not offer Select all matching when everything fits on the page', async () => {
    serve(() => pageOf([confirmation()], { total: 1 }));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    expect(screen.queryByRole('button', { name: /Select all .* matching/ })).toBeNull();
  });
});

describe('Invoices words for the rows', () => {
  it('names credit notes on the Credit notes tab, in the count and selection', async () => {
    serve(
      byKind([confirmation()], [creditNote(), creditNote({ documentId: 'x9' })], { total: 143 }),
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['kind']).toBe('credit-note'));
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select all credit notes on this page' }),
    );
    expect(screen.getByText('2 credit notes selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching credit notes are selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bulk action' })).toHaveProperty('disabled', false);
  });

  it('never says "document" to an admin, whatever the tab or count', () => {
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === 'string') {
        if (/document/i.test(node.replace(/\{[^}]*\}/g, ''))) found.push(`${path}: ${node}`);
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      }
    };
    walk(messages.invoices, 'invoices');
    expect(found).toEqual([]);
  });
});

describe('Invoices out-of-order answers', () => {
  type Reply = { ok: true; status: 200; body: DocumentsPage } | { ok: false; failure: object };
  /** Answers the requests of the credit-note tab by hand; the first tab answers at once. */
  function held() {
    const waiting: ((reply: Reply) => void)[] = [];
    call.mockImplementation((_method, path) => {
      if (path.startsWith('lists/admin/saved-filters')) return noSavedRoute('GET', path, undefined);
      if (path.includes('kind=order-confirmation') && !path.includes('search=')) {
        return Promise.resolve({ ok: true, status: 200, body: pageOf([confirmation()]) } as never);
      }
      return new Promise((resolve) => {
        waiting.push(resolve);
      }) as never;
    });
    return waiting;
  }
  const body = (storeName: string, total: number, counts = COUNTS) =>
    ({
      ok: true,
      status: 200,
      body: pageOf([creditNote({ storeName })], { total, counts }),
    }) as const;

  it('shows the rows, counts and total of the last request when the answers arrive in reverse', async () => {
    const waiting = held();
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    // A: the Credit notes tab. B: a search typed after it.
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(waiting).toHaveLength(1));
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'Store B' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(waiting).toHaveLength(2));
    // B answers first, then the older A.
    act(() => {
      waiting[1]!(body('Store B', 2, { ...COUNTS, creditNotes: 40 }));
    });
    expect(await screen.findByText('Store B')).toBeTruthy();
    act(() => {
      waiting[0]!(body('Store A', 1, { ...COUNTS, creditNotes: 99 }));
    });
    expect(screen.getByText('Store B')).toBeTruthy();
    expect(screen.queryByText('Store A')).toBeNull();
    expect(screen.getByRole('button', { name: 'Credit notes (40)' })).toBeTruthy();
    expect(screen.getByText('1 to 1 of 2')).toBeTruthy();
  });

  it('shows no error when the older request fails after the newer one answered', async () => {
    const waiting = held();
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(waiting).toHaveLength(1));
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'Store B' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(waiting).toHaveLength(2));
    act(() => {
      waiting[1]!(body('Store B', 1));
    });
    await screen.findByText('Store B');
    act(() => {
      waiting[0]!({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    });
    expect(screen.queryByText("Invoices couldn't be loaded.")).toBeNull();
    expect(screen.getByText('Store B')).toBeTruthy();
  });

  it('drops the answer that arrives after the first load gave up at 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let late: ((reply: Reply) => void) | null = null;
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }) as never,
    );
    mount();
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(screen.getByText("Invoices couldn't be loaded.")).toBeTruthy();
    act(() => {
      late!(body('Late Store', 1));
    });
    expect(screen.queryByText('Late Store')).toBeNull();
    expect(screen.getByText("Invoices couldn't be loaded.")).toBeTruthy();
  });
});

describe('Invoices query refused by the API', () => {
  it('says the search cannot be run, without a Try again that could never work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    call.mockImplementation(
      (_method, path) =>
        Promise.resolve(
          path.includes('q=')
            ? { ok: false, failure: { status: 422, code: 'validation.failed' } }
            : { ok: true, status: 200, body: pageOf([confirmation()]) },
        ) as never,
    );
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: '0190a000-0000-7000-8000-0000000000e5' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(
      await screen.findByText(
        "This search can't be run. Change the text or the filters, or clear them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Invoices couldn't be loaded.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('Invoices states', () => {
  it('shows a loading status on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading invoices...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("Invoices couldn't be loaded.")).toBeTruthy();
    serve(() => pageOf([confirmation()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('credit-note') ? 'fail' : pageOf([confirmation()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    expect(await screen.findByText("Invoices couldn't be loaded.")).toBeTruthy();
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
    expect(await screen.findByText("You don't have access to invoices.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
  });

  it('shows the empty state of each tab', async () => {
    serve(() => pageOf([]));
    mount();
    expect(await screen.findByRole('heading', { name: 'No order confirmations yet' })).toBeTruthy();
    expect(screen.getByText('One is issued for each seller when an order is paid.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    expect(await screen.findByRole('heading', { name: 'No credit notes yet' })).toBeTruthy();
    expect(screen.getByText('One is issued for each completed refund.')).toBeTruthy();
  });

  it('says nothing matches a filter, with Clear all to start again', async () => {
    serve((url) => (url.includes('from=') ? pageOf([]) : pageOf([confirmation()])));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'issued' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'yesterday' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('heading', { name: 'No invoices match' })).toBeTruthy();
    expect(screen.getByText('Try other filters or clear them.')).toBeTruthy();
    const clear = screen
      .getAllByRole('button', { name: 'Clear all' })
      .find((button) => button.closest('td') !== null)!;
    fireEvent.click(clear);
    expect(await screen.findByText('Cedar Lane Halal Meats')).toBeTruthy();
  });
});

describe('Invoices column choice', () => {
  const KEY = 'mp:admin:AU:acc-1:invoices-columns';

  it('uses the column ids the export backend expects', () => {
    expect([...OPTIONAL_COLUMNS]).toEqual([
      'issued',
      'store',
      'customer',
      'total',
      'tax',
      'reason',
      'shipping',
      'sellerOrderId',
      'documentId',
      'refundId',
    ]);
  });

  it('labels the credit-note-only columns in the picker, and keeps the choice per Market and account', async () => {
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).getAllByText('Always shown')).toHaveLength(1);
    for (const name of [
      'Reason (credit notes only)',
      'Credit note ID (credit notes only)',
      'Refund ID (credit notes only)',
    ]) {
      expect(within(panel).getByRole('checkbox', { name })).toBeTruthy();
    }
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Delivery (incl. tax)' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Customer' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Delivery (incl. tax) up' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([
      'issued',
      'store',
      'total',
      'tax',
      'shipping',
      'reason',
    ]);
    expect(headers()).toEqual([
      '',
      'Order',
      'Issued',
      'Store',
      'Total (incl. tax)',
      'Tax',
      'Delivery (incl. tax)',
      'Actions',
    ]);
  });

  it('reads the choice back, and keys it by Market', async () => {
    window.localStorage.setItem('mp:admin:ZZ:acc-1:invoices-columns', JSON.stringify(['tax']));
    serve(() => pageOf([confirmation()]));
    mount({ marketId: 'ZZ' });
    await screen.findByText('$11.41');
    expect(headers()).toEqual(['', 'Order', 'Tax', 'Actions']);
    cleanup();
    mount({ marketId: 'AU' });
    await screen.findByText('Cedar Lane Halal Meats');
    expect(headers()).toHaveLength(8);
  });

  it('ignores a stored column that no longer exists, and puts the defaults back with Reset', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['gone', 'tax', 'tax']));
    serve(() => pageOf([confirmation()]));
    mount();
    await screen.findByText('$11.41');
    expect(headers()).toEqual(['', 'Order', 'Tax', 'Actions']);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Reset to default' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(headers()).toHaveLength(8);
  });

  it('works when the browser storage refuses', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      serve(() => pageOf([confirmation()]));
      mount();
      await screen.findByText('Cedar Lane Halal Meats');
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      const panel = await screen.findByRole('dialog', { name: 'Columns' });
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Delivery (incl. tax)' }));
      fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('columnheader', { name: 'Delivery (incl. tax)' })).toBeTruthy();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('cleans a stored choice to known columns without repeats', () => {
    expect(cleanColumns(undefined)).toEqual([
      'issued',
      'store',
      'customer',
      'total',
      'tax',
      'reason',
    ]);
    expect(cleanColumns(['x', 'tax', 'tax', 3])).toEqual(['tax']);
    expect(cleanColumns([])).toEqual([]);
  });
});

describe('Invoices nav', () => {
  it('sits in Sales with the file icon, and needs the order view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('invoices');
    expect(ids(['ordering.order.view'])).toContain('invoices');
    expect(adminNav.items.find((item) => item.id === 'invoices')).toMatchObject({
      icon: 'file',
      href: '/invoices',
      group: 'sales',
      labelKey: 'nav.invoices',
      anyOf: ['ordering.order.view'],
    });
    expect(messages.nav.invoices).toBe('Invoices');
  });
});

describe('Invoices Export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
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
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
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
      'mp:admin:AU:acc-1:invoices-columns',
      JSON.stringify(['total', 'reason', 'documentId', 'store']),
    );
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount({ zone: LOS_ANGELES });
    await screen.findAllByText('Cedar Lane Halal Meats');

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    answerWith(
      () => new Response('﻿Order ID\r\nrow 1\r\nrow 2\r\n', { status: 200, headers: CSV }),
    );
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(sent()).toEqual({
      path: '/api/ordering/admin/documents/export',
      params: {
        format: 'csv',
        kind: 'order-confirmation',
        columns: 'total,store',
        zone: LOS_ANGELES,
        ids: '0190a000-0000-7000-8000-0000000000d1,0190a000-0000-7000-8000-0000000000d2',
      },
    });
    expect(names).toEqual([expect.stringMatching(/^order-confirmations-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  it('sends no ids after "Select all matching", takes the file name from the server and counts the total', async () => {
    serve(() => pageOf([confirmation()], { total: 143 }));
    mount({ paging: 'pages' });
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            'content-type': XLSX,
            'content-disposition': 'attachment; filename="order-confirmations-2026-11-17.xlsx"',
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
    expect(names).toEqual(['order-confirmations-2026-11-17.xlsx']);
  });

  it('leaves out page, cursor and limit with Previous and next, and counts the rows of a CSV with a line break inside a cell', async () => {
    serve(() => cursorPage([confirmation()], cursor(1)));
    mount({ paging: 'prev-next' });
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    answerWith(
      () =>
        new Response('Order ID,Note\r\nr1,"two\r\nlines"\r\nr2,x\r\n', {
          status: 200,
          headers: CSV,
        }),
    );
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    const { params } = sent();
    for (const key of ['ids', 'page', 'pageSize', 'sort', 'direction', 'cursor', 'limit']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it('says so when there are too many rows', async () => {
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
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
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
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
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
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
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    answerWith(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('network'));
            },
          }),
          { status: 200, headers: CSV },
        ),
    );
    confirm(await openExport());
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('closes the dialog without a request when it is cancelled', async () => {
    serve(() =>
      pageOf([
        confirmation(),
        confirmation({ documentId: '0190a000-0000-7000-8000-0000000000d2' }),
      ]),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select order 00000001' })[0]!);
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetched).toEqual([]);
  });

  it('sends kind=credit-note and the credit note columns from the Credit notes tab, keyed by document id', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:invoices-columns',
      JSON.stringify(['total', 'reason', 'documentId', 'store']),
    );
    serve(
      byKind(
        [confirmation()],
        [creditNote(), creditNote({ documentId: '0190a000-0000-7000-8000-0000000000e2' })],
      ),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(lastUrl()).toContain('kind=credit-note'));
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all credit notes on this page' }));
    answerWith(() => new Response('Credit note ID\r\na\r\nb\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(sent().params).toEqual({
      format: 'csv',
      kind: 'credit-note',
      columns: 'total,reason,documentId,store',
      zone: BRISBANE,
      ids: '0190a000-0000-7000-8000-0000000000e1,0190a000-0000-7000-8000-0000000000e2',
    });
    expect(names).toEqual([expect.stringMatching(/^credit-notes-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  // The backend filters `id IN ids`: the seller order id of a confirmation (its document id is that
  // id) and the credit note id of a credit note (its seller order id is another id).
  it('sends the id the backend filters on: the seller order id of a confirmation, the credit note id of a credit note', async () => {
    const OTHER_ORDER = '0190a000-0000-7000-8000-0000000000d9';
    serve(
      byKind(
        [confirmation({ documentId: SELLER_ORDER, sellerOrderId: SELLER_ORDER })],
        [creditNote({ documentId: CREDIT_ID, sellerOrderId: OTHER_ORDER })],
      ),
    );
    mount();
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select all order confirmations on this page' }),
    );
    answerWith(() => new Response('Order ID\r\na\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(sent().params['ids']).toBe(SELLER_ORDER);
    toast.dismiss();

    fireEvent.click(screen.getByRole('button', { name: /^Credit notes/ }));
    await waitFor(() => expect(lastUrl()).toContain('kind=credit-note'));
    await screen.findAllByText('Cedar Lane Halal Meats');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all credit notes on this page' }));
    confirm(await openExport());
    await waitFor(() => expect(fetched).toHaveLength(2));
    expect(sent().params['ids']).toBe(CREDIT_ID);
    expect(sent().params['ids']).not.toContain(OTHER_ORDER);
  });
});
