// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Toaster, toast } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import {
  DEFAULT_QUERY,
  cleanColumns,
  exportQuery,
  payloadOf,
  queryOf,
  queryString,
} from './list-types.ts';
import { RequestsList } from './requests-list.tsx';
import type { ListPage, ListRow } from './types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
const LOS_ANGELES = 'America/Los_Angeles';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane, still the 16th in Los Angeles.
const NOW = new Date('2026-11-16T20:30:00.000Z');

const id = (n: number) => `0190a000-0000-7000-8000-0000000000e${n}`;
const SELLER = '0190a000-0000-7000-8000-00000000abcd';
const STORE = 'Logan Road Grocer';
const TYPES = { halal: 'Halal', kosher: 'Kosher' };

const row = (over: Partial<ListRow> = {}): ListRow => ({
  issuerRequestId: id(1),
  version: 2,
  typeCode: 'halal',
  sellerId: SELLER,
  storeName: STORE,
  documentCount: 2,
  createdAt: '2026-11-09T01:00:00.000Z',
  actions: ['open', 'answer'],
  ...over,
});
const pageOf = (items: ListRow[], over: Partial<ListPage> = {}): ListPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: { all: 12 },
  truncated: false,
  ...over,
});
/** The answer of Previous and next: no total. */
const openPage = (items: ListRow[], hasNext = false, over: Partial<ListPage> = {}) =>
  pageOf(items, { total: null, paging: 'prev-next', hasNext, ...over });

type Answer = ListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';

/** Until a test says otherwise the saved-filter route is not there: the controls stay hidden. */
type SavedRoute = (method: string, path: string, body: unknown) => Promise<never>;
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } } as never);

function serve(answer: (url: string) => Answer, saved: SavedRoute = noSavedRoute) {
  call.mockImplementation((method, path, body) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path, body);
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    if (result === 'denied') {
      return Promise.resolve({ ok: false, failure: { status: 403, code: 'access.denied' } });
    }
    if (result === 'refused') {
      return Promise.resolve({ ok: false, failure: { status: 400, code: 'validation.failed' } });
    }
    if (result === 'unauthenticated') {
      return Promise.resolve({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const urls = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((url) => !url.startsWith('lists/admin/saved-filters'));
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    sellerId?: string | null;
    typeNames?: Record<string, string>;
    locale?: string;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale={options.locale ?? 'en-AU'} messages={messages}>
      <RequestsList
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId={options.marketId ?? 'AU'}
        zone={options.zone ?? BRISBANE}
        typeNames={options.typeNames ?? TYPES}
        sellerId={options.sellerId ?? null}
        csrfToken="csrf"
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

describe('Issuer requests list: page numbers', () => {
  it('asks for page 1, oldest first, with the paging mode, and shows the header and sorted line', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    expect(await screen.findByRole('link', { name: STORE })).toBeTruthy();
    expect(urls()[0]).toBe(
      'certification/admin/issuer-requests/list?sort=submitted&direction=asc&paging=pages&page=1&pageSize=25',
    );
    expect(screen.getByText('12 requests are open, oldest first.')).toBeTruthy();
    expect(screen.getByText('Times and days are in Australia/Brisbane.')).toBeTruthy();
    expect(screen.getByText('Sorted by Submitted: Oldest first')).toBeTruthy();
    expect(screen.getByText('1 to 1 of 143')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All (12)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // No saved-filter route: the controls are hidden, and the rows hold no button.
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save filter/ })).toBeNull();
  });

  it('has one link to the request on the store, a fallback for a seller not approved, and the type name', async () => {
    serve(() =>
      pageOf([row(), row({ issuerRequestId: id(2), storeName: null, typeCode: 'organic' })]),
    );
    mount();
    expect(await screen.findByRole('link', { name: STORE })).toHaveProperty(
      'href',
      expect.stringContaining(`/certificates/issuer-requests/${id(1)}`),
    );
    expect(screen.getByRole('link', { name: 'Not yet approved' })).toBeTruthy();
    expect(screen.getAllByText('Halal')).toHaveLength(1);
    // A type without a name shows its code.
    expect(screen.getByText('organic')).toBeTruthy();
    expect(screen.getAllByText('Seller ID 0000ABCD')).toHaveLength(2);
  });

  it('shows times in the list zone, and the same instant on another zone', async () => {
    serve(() => pageOf([row({ createdAt: NOW.toISOString() })]));
    mount();
    expect(await screen.findByText(/17 Nov/)).toBeTruthy();
    cleanup();
    mount({ zone: LOS_ANGELES });
    expect(await screen.findByText(/16 Nov/)).toBeTruthy();
  });

  it('sorts by Type, A to Z, then Z to A, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Type' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toMatchObject({ sort: 'type', page: '1' }));
    expect(paramsOf(lastUrl())['direction']).toBe('asc');
    fireEvent.click(within(panel).getByRole('radio', { name: 'Z to A' }));
    await waitFor(() => expect(paramsOf(lastUrl())['direction']).toBe('desc'));
    expect(screen.getByText('Sorted by Type: Z to A')).toBeTruthy();
  });

  it('changes the page size and goes back to page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(paramsOf(lastUrl())).toMatchObject({ pageSize: '50', page: '1' }));
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

describe('Issuer requests list: Previous and next', () => {
  it('sends paging=prev-next, keeps Sort, shows no total and no page numbers', async () => {
    serve(() => openPage([row()], true));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(paramsOf(urls()[0]!)).toMatchObject({ paging: 'prev-next', page: '1' });
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy();
    expect(screen.getByText('1 to 1')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });

  it('walks Next and Previous by page number, and ends Next when the API says no more', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '2'
        ? openPage([row()], false, { page: 2 })
        : openPage([row()], true),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
  });

  it('follows the answer when the API sends a total although the setting says Previous and next', async () => {
    serve(() => pageOf([row()], { total: 30 }));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(screen.getByText('1 to 1 of 30')).toBeTruthy();
  });

  it('offers "Select all matching" without a number', async () => {
    serve(() => openPage([row()], true));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching requests are selected')).toBeTruthy();
  });
});

describe('Issuer requests list: second fixture ZZ', () => {
  it('follows the Market paging mode and the list zone', async () => {
    serve(() => openPage([row()], true));
    mount({ marketId: 'ZZ', zone: 'Pacific/Auckland', paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(paramsOf(urls()[0]!)).toMatchObject({ paging: 'prev-next', page: '1' });
    expect(screen.getByText('Times and days are in Pacific/Auckland.')).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });
});

describe('Issuer requests list: search', () => {
  const box = () => screen.getByRole('searchbox', { name: 'Search' });
  const ID = id(5);

  it('sends a whole request id, lower-cased, as q on Enter, with a removable chip', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(box().getAttribute('placeholder')).toBe('Request ID');
    fireEvent.change(box(), { target: { value: ID.toUpperCase() } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Request 000000E5' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('asks for nothing for text that is not an id, and says what to type after Enter', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const before = urls().length;
    fireEvent.change(box(), { target: { value: 'logan' } });
    expect(screen.queryByText(/Enter a whole request ID/)).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/Enter a whole request ID/)).toBeTruthy();
    expect(urls().length).toBe(before);
  });

  it('sends the id after the typing pause too', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.change(box(), { target: { value: ID } });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(ID));
  });
});

describe('Issuer requests list: filters and chips', () => {
  async function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    return screen.findByRole('dialog', { name: 'Filter' });
  }

  it('offers Type and Submitted with their values', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const panel = await openPanel();
    const field = within(panel).getByLabelText('Field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Type', 'Submitted']);
    fireEvent.change(field, { target: { value: 'type' } });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .slice(1),
    ).toEqual(['Halal', 'Kosher']);
  });

  it('has no Type field when the admin may not read the types', async () => {
    serve(() => pageOf([row()]));
    mount({ typeNames: {} });
    await screen.findByText(STORE);
    const panel = await openPanel();
    expect(
      within(within(panel).getByLabelText('Field'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Submitted']);
  });

  it('filters by type and Submitted, as chips that can be removed one by one', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'type' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'kosher' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const fields = within(panel).getAllByLabelText('Field');
    fireEvent.change(fields[fields.length - 1]!, { target: { value: 'submitted' } });
    const values = within(panel).getAllByLabelText('Value');
    fireEvent.change(values[values.length - 1]!, { target: { value: 'last-7-days' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['type']).toBe('kosher'));
    expect(paramsOf(lastUrl())).toHaveProperty('from');
    expect(paramsOf(lastUrl())).toHaveProperty('to');
    expect(screen.getByText('1 request matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Type is Kosher' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('type'));
    expect(paramsOf(lastUrl())).toHaveProperty('from');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Submitted is Last 7 days' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('from'));
  });

  it('reads the Submitted preset on the clock of the list zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'submitted' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'today' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toHaveProperty('from'));
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
  });

  it('shows a removable Seller chip when a link names one, with the store name or the short id', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(STORE);
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    expect(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
  });

  it('clears the search, filters and seller together with Clear all', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(STORE);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: id(5) },
    });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search' }), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(id(5)));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId');
  });

  it('says nothing matches, with Clear all to start again', async () => {
    serve((url) => (url.includes('type=kosher') ? pageOf([], { total: 0 }) : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'type' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'kosher' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No requests match')).toBeTruthy();
    fireEvent.click(
      within(screen.getByText('No requests match').closest('div')!.parentElement!).getByRole(
        'button',
        { name: 'Clear all' },
      ),
    );
    expect(await screen.findByText(STORE)).toBeTruthy();
  });
});

describe('Issuer requests list: rows, Actions and selection', () => {
  const OPEN = (name: string) => screen.getByRole('button', { name });

  it('lists Open request and Answer request, as the row names them, and goes to the page', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for request 000000E1'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open request', 'Answer request']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Answer request' }));
    expect(push).toHaveBeenCalledWith(`/certificates/issuer-requests/${id(1)}#rq-answer`);
  });

  it('opens the request from the menu without the answer anchor', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for request 000000E1'));
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Open request' }),
    );
    expect(push).toHaveBeenCalledWith(`/certificates/issuer-requests/${id(1)}`);
  });

  it('offers only what the row names: no Answer without the edit key, an unknown id ignored', async () => {
    serve(() =>
      pageOf([
        row({ actions: ['open', 'mystery'] }),
        row({ issuerRequestId: id(2), actions: [] }),
        row({ issuerRequestId: id(3), actions: ['answer', 'open'] }),
      ]),
    );
    mount();
    await screen.findAllByText(STORE);
    expect(screen.getAllByRole('button', { name: /^Actions for request/ })).toHaveLength(2);
    fireEvent.click(OPEN('Actions for request 000000E1'));
    expect(
      within(await screen.findByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open request']);
  });

  it('keeps a fixed menu order whatever the order of the row array', async () => {
    serve(() => pageOf([row({ actions: ['answer', 'open'] })]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN('Actions for request 000000E1'));
    expect(
      within(await screen.findByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open request', 'Answer request']);
  });

  it('has no button inside a row except the select box and the Actions menu', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const body = screen.getAllByRole('row')[1]!;
    expect(
      within(body)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['Actions for request 000000E1']);
  });

  it('shows the optional columns in the chosen order, and a never-before-seen id as text', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:issuer-requests-columns',
      JSON.stringify(['seller-id', 'request-id', 'documents', 'gone']),
    );
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const heads = screen.getAllByRole('columnheader').map((head) => head.textContent);
    expect(heads).toEqual([
      '',
      'Seller',
      'Type',
      'Submitted',
      'Seller ID',
      'Request ID',
      'Files',
      'Actions',
    ]);
  });

  it('keeps the column choice per Market and account, and works when storage refuses', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Move Files down' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(window.localStorage.getItem('mp:admin:AU:acc-1:issuer-requests-columns')).not.toBeNull();
    cleanup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount({ marketId: 'ZZ' });
    expect(await screen.findByText(STORE)).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('cleans a stored column choice to the ids the export reads', () => {
    expect(cleanColumns(undefined)).toEqual(['documents']);
    expect(cleanColumns(['seller-id', 'seller-id', 'nope', 'documents'])).toEqual([
      'seller-id',
      'documents',
    ]);
    expect(cleanColumns([])).toEqual([]);
  });

  it('offers "Select all N matching" after the page is ticked, and not when everything fits', async () => {
    serve(() => pageOf([row(), row({ issuerRequestId: id(2) })], { total: 60 }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    expect(screen.getByText('2 requests selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 60 matching' }));
    expect(screen.getByText('All 60 matching requests are selected')).toBeTruthy();
    cleanup();
    serve(() => pageOf([row()], { total: 1 }));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    expect(screen.queryByRole('button', { name: /Select all .* matching/ })).toBeNull();
  });

  it('has the phone layout: a select-all bar and a labelled line per cell', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    // The bar of cards, shown below 1024 px by CSS, and the label each card line carries.
    expect(screen.getByText('Select all on this page')).toBeTruthy();
    const body = screen.getAllByRole('row')[1]!;
    const labels = [...body.querySelectorAll('td[data-label]')].map((cell) =>
      cell.getAttribute('data-label'),
    );
    expect(labels).toEqual(['Type', 'Submitted', 'Files']);
    expect(within(body).getByRole('button', { name: /^Actions for request/ })).toBeTruthy();
  });
});

describe('Issuer requests list: states', () => {
  it('shows the truncated notice only when the API says so', async () => {
    serve(() => pageOf([row()], { truncated: true }));
    mount();
    expect(
      await screen.findByText(
        'Showing the 500 oldest open requests. Answer some to see newer ones.',
      ),
    ).toBeTruthy();
    cleanup();
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(screen.queryByText(/oldest open requests/)).toBeNull();
  });

  it('shows skeleton rows with a loading status on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading issuer requests...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('says so when no request is open', async () => {
    serve(() => pageOf([], { total: 0, counts: { all: 0 } }));
    mount();
    expect(await screen.findByText('No issuer requests are open.')).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("Issuer requests couldn't be loaded.")).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(STORE)).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('type=kosher') ? 'fail' : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'type' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'kosher' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText("Issuer requests couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText(STORE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for request/ })).toBeNull();
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
    expect(await screen.findByText("You don't have access to issuer requests.")).toBeTruthy();
    expect(screen.getByText(/needs the issuer view permission/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
  });

  it('says the search cannot be run on validation.failed, with no Try again', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('Issuer requests list: saved filters', () => {
  const FILTER = {
    id: 'sf-1',
    listKey: 'admin.certification.issuer-requests',
    name: 'Kosher only',
    visibility: 'me',
    payload: { v: 1, view: 'all', filters: { type: 'kosher' }, sort: 'type', direction: 'desc' },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
  const routes: SavedRoute = (method, path) =>
    Promise.resolve(
      method === 'GET' && path.startsWith('lists/admin/saved-filters')
        ? { ok: true, status: 200, body: { items: [FILTER], canShare: true } }
        : { ok: false, failure: { status: 404, code: 'not-found' } },
    ) as never;

  it('shows a saved filter as a tab and opens it with its own filters and sort only', async () => {
    serve(() => pageOf([row()]), routes);
    mount();
    await screen.findByText(STORE);
    expect(
      call.mock.calls.some(
        (c) => c[1] === 'lists/admin/saved-filters?listKey=admin.certification.issuer-requests',
      ),
    ).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Kosher only' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        type: 'kosher',
        sort: 'type',
        direction: 'desc',
      }),
    );
    // Back to the built-in tab: nothing of the saved filter is carried over.
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('type'));
    expect(paramsOf(lastUrl())).toMatchObject({ sort: 'submitted', direction: 'asc' });
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
  });

  it("keeps the built-in tab's count when a saved filter is open", async () => {
    serve(
      (url) => pageOf([row()], { counts: { all: url.includes('type=kosher') ? 2 : 12 } }),
      routes,
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(await screen.findByRole('button', { name: 'Kosher only' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toHaveProperty('type', 'kosher'));
    expect(await screen.findByRole('button', { name: 'All (12)' })).toBeTruthy();
  });

  it('offers Save filter on a built-in tab with a filter, and posts the closed document', async () => {
    const posted: unknown[] = [];
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    serve(
      () => pageOf([row()]),
      (method, path, body) => {
        if (method === 'POST') {
          posted.push(body);
          return Promise.resolve({
            ok: true,
            status: 201,
            body: { ...FILTER, id: 'sf-2' },
          }) as never;
        }
        return routes(method, path, body);
      },
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'type' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'halal' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['type']).toBe('halal'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this filter' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Halal only' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      listKey: 'admin.certification.issuer-requests',
      name: 'Halal only',
      visibility: 'me',
      payload: { v: 1, view: 'all', filters: { type: 'halal' } },
    });
  });
});

describe('Issuer requests list: query and saved document rules', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query for both Markets zones and both paging modes', () => {
    expect(queryString(DEFAULT_QUERY, context)).toBe(
      'sort=submitted&direction=asc&paging=pages&page=1&pageSize=25',
    );
    const query = {
      ...DEFAULT_QUERY,
      q: id(5).toUpperCase(),
      sellerId: SELLER,
      filters: { type: 'kosher', submitted: 'yesterday' as const },
      page: 3,
      pageSize: 50,
    };
    const brisbane = Object.fromEntries(new URLSearchParams(queryString(query, context)));
    const la = Object.fromEntries(
      new URLSearchParams(queryString(query, { ...context, zone: LOS_ANGELES })),
    );
    expect(brisbane).toMatchObject({ type: 'kosher', q: id(5), sellerId: SELLER, page: '3' });
    expect(brisbane['from']).toBe('2026-11-15T14:00:00.000Z');
    expect(la['from']).toBe('2026-11-15T08:00:00.000Z');
    expect(
      Object.fromEntries(
        new URLSearchParams(queryString(query, { ...context, paging: 'prev-next' })),
      )['paging'],
    ).toBe('prev-next');
  });

  it('drops a search that is not an id and keeps unknown saved values out', () => {
    expect(queryString({ ...DEFAULT_QUERY, q: 'logan' }, context)).not.toContain('q=');
    const query = queryOf(
      {
        v: 1,
        view: 'all',
        filters: { type: 'Bad Code!', submitted: 'someday' } as never,
        sort: 'nope' as never,
        direction: 'sideways' as never,
      },
      50,
    );
    expect(query).toMatchObject({ filters: {}, sort: 'submitted', direction: 'asc', pageSize: 50 });
    expect(payloadOf({ ...DEFAULT_QUERY, filters: { type: 'halal' } })).toEqual({
      v: 1,
      view: 'all',
      filters: { type: 'halal' },
    });
    expect(payloadOf(DEFAULT_QUERY)).toEqual({ v: 1, view: 'all' });
  });

  it('builds the export for ticked ids without a filter or a sort, and for the filter with them', () => {
    const ids = exportQuery({
      query: { ...DEFAULT_QUERY, filters: { type: 'halal' } },
      context,
      format: 'xlsx',
      columns: ['request-id', 'documents'],
      selection: { ids: [id(1), id(2)], allMatching: false, total: null },
    });
    expect(Object.fromEntries(new URLSearchParams(ids))).toEqual({
      ids: `${id(1)},${id(2)}`,
      format: 'xlsx',
      columns: 'request-id,documents',
    });
    const all = Object.fromEntries(
      new URLSearchParams(
        exportQuery({
          query: { ...DEFAULT_QUERY, filters: { type: 'halal' }, page: 4 },
          context,
          format: 'csv',
          columns: [],
          selection: { ids: [], allMatching: true, total: 60 },
        }),
      ),
    );
    expect(all).toEqual({
      type: 'halal',
      sort: 'submitted',
      direction: 'asc',
      format: 'csv',
      columns: '',
    });
    expect(() =>
      exportQuery({
        query: DEFAULT_QUERY,
        context,
        format: 'csv',
        columns: [],
        selection: { ids: [], allMatching: false, total: null },
      }),
    ).toThrow();
  });
});

describe('Issuer requests list: export', () => {
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
    serve(() => pageOf([row(), row({ issuerRequestId: id(2) })]));
    mount();
    await screen.findAllByText(STORE);
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select request 000000E1' })[0]!);
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

  it('sends only the ticked ids, the shown columns in order and the format', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:issuer-requests-columns',
      JSON.stringify(['seller-id', 'documents']),
    );
    serve(() => pageOf([row(), row({ issuerRequestId: id(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    answerWith(() => new Response('Type\r\nrow 1\r\nrow 2\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(sent()).toEqual({
      path: '/api/certification/admin/issuer-requests/export',
      params: {
        ids: `${id(1)},${id(2)}`,
        format: 'csv',
        columns: 'seller-id,documents',
      },
    });
    expect(names).toEqual([expect.stringMatching(/^issuer-requests-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  it('sends the list filter and sort, and no ids or page, after "Select all matching"', async () => {
    serve(() => pageOf([row()], { total: 60 }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'type' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'halal' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['type']).toBe('halal'));
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 60 matching' }));
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            'content-type': XLSX,
            'content-disposition': 'attachment; filename="issuer-requests-2026-11-17.xlsx"',
          },
        }),
    );
    confirm(await openExport(), 'XLSX');
    expect(await screen.findByText('Exported 60 rows.')).toBeTruthy();
    expect(sent().params).toEqual({
      type: 'halal',
      sort: 'submitted',
      direction: 'asc',
      format: 'xlsx',
      columns: 'documents',
    });
    expect(names).toEqual(['issuer-requests-2026-11-17.xlsx']);
  });

  it('does not offer "Select all matching" when the list is cut at 500: ticked rows still export by id', async () => {
    serve(() => pageOf([row()], { total: 60, truncated: true }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    expect(screen.queryByRole('button', { name: /^Select all .* matching$/ })).toBeNull();
    answerWith(() => new Response('\uFEFFRequest\r\nrow 1\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(sent().params['ids']).toBe(id(1));
    expect(sent().params['view']).toBeUndefined();
  });

  it('says so when the API refuses an export with 413 batch.too-large', async () => {
    serve(() => pageOf([row()], { total: 60 }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    answerWith(
      () =>
        new Response(JSON.stringify({ code: 'batch.too-large', details: { max: 500 } }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        }),
    );
    confirm(await openExport());
    expect(await screen.findByText(/Too many rows to export/)).toBeTruthy();
  });

  it('exports the shown columns of the second fixture ZZ, read from its own preference key', async () => {
    window.localStorage.setItem(
      'mp:admin:ZZ:acc-1:issuer-requests-columns',
      JSON.stringify(['seller-id']),
    );
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ', zone: 'Pacific/Auckland' });
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    answerWith(() => new Response('\uFEFFRequest\r\nrow 1\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(sent().params).toEqual({ format: 'csv', columns: 'seller-id', ids: id(1) });
  });

  it('says so when the export fails, and when one id is no longer open', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    answerWith(() => new Response('{}', { status: 503 }));
    confirm(await openExport());
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    answerWith(
      () =>
        new Response(JSON.stringify({ code: 'issuer-request.not-found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    confirm(await openExport());
    await waitFor(() => expect(fetched).toHaveLength(2));
    expect((await screen.findAllByText('Export failed. Try again.')).length).toBeGreaterThan(0);
  });

  it('closes the dialog without a request when it is cancelled', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all requests on this page' }));
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetched).toEqual([]);
  });
});
