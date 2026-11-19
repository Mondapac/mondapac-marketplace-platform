// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Toaster, toast, visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import { DEFAULT_QUERY, listBody } from './seller-list-query.ts';
import { payloadOf, queryOf, somethingToSave } from './seller-list-saved.ts';
import { SellersList } from './sellers-list.tsx';
import type { SellerSuperPage, SellerSuperRow, Tab } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Partial<SellerSuperRow> = {}): SellerSuperRow => ({
  sellerId: id(n),
  storeName: `Store ${n}`,
  slug: `store-${n}`,
  status: 'awaiting-review',
  owner: { displayName: `Owner ${n}`, email: `owner${n}@example.com` },
  origin: 'self',
  kind: 'onboarding',
  submittedAt: '2026-10-08T01:00:00.000Z',
  serviceAreaCode: 'greater-brisbane',
  serviceAreaName: 'Greater Brisbane',
  timezone: 'Australia/Brisbane',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastChangedAt: '2026-10-08T01:00:00.000Z',
  actions: ['open'],
  ...over,
});
const COUNTS = { awaitingReview: { onboarding: 2, identityChange: 1 }, incomplete: 4, all: 9 };
const STATE_COUNTS = { changesNeeded: 3, notApproved: 2, approved: 7, suspended: 1 };
const AREAS = [
  { code: 'greater-brisbane', name: 'Greater Brisbane' },
  { code: 'gold-coast', name: 'Gold Coast' },
];
const pageOf = (items: SellerSuperRow[], over: Partial<SellerSuperPage> = {}): SellerSuperPage => ({
  tab: 'all',
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: COUNTS,
  stateCounts: STATE_COUNTS,
  areas: AREAS,
  healthUnavailable: false,
  ...over,
});
const openPage = (items: SellerSuperRow[], hasNext = false, page = 1) =>
  pageOf(items, { total: null, paging: 'prev-next', hasNext, page });

type Answer = SellerSuperPage | 'fail' | 'denied' | 'unauthenticated' | 'refused' | 'too-broad';

type SavedRoute = (method: string, path: string) => Promise<never>;
/** Until a test says otherwise the saved-filter route is not there: the controls stay hidden. */
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } } as never);

/** The list answers by its body, so the order of the calls does not matter. */
function serve(
  answer: (body: Record<string, unknown>) => Answer,
  saved: SavedRoute = noSavedRoute,
) {
  call.mockImplementation((method, path, body) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path);
    const result = answer(body as Record<string, unknown>);
    const failure = (status: number, code: string) =>
      Promise.resolve({ ok: false as const, failure: { status, code } });
    if (result === 'fail') return failure(503, 'sellers.unavailable');
    if (result === 'denied') return failure(403, 'access.denied');
    if (result === 'unauthenticated') return failure(401, 'session.invalid');
    if (result === 'refused') return failure(400, 'validation.failed');
    if (result === 'too-broad') return failure(400, 'search.too-broad');
    return Promise.resolve({ ok: true as const, status: 200, body: result } as never);
  });
}
const bodies = () =>
  call.mock.calls
    .filter((entry) => !entry[1].startsWith('lists/admin/'))
    .map((entry) => entry[2] as Record<string, unknown>);
const lastBody = () => bodies()[bodies().length - 1]!;

function mount(options: { paging?: 'pages' | 'prev-next'; initialTab?: Tab } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellersList
        csrfToken="csrf-1"
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId="AU"
        {...(options.initialTab === undefined ? {} : { initialTab: options.initialTab })}
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

describe('Sellers list: rows and views', () => {
  it('posts page 1 of All with the CSRF token, the sort and the Market paging mode', async () => {
    serve(() => pageOf([row(1), row(2)]));
    mount();
    await screen.findByText('Store 1');
    expect(call).toHaveBeenCalledWith(
      'POST',
      'sellers/admin/sellers/list',
      {
        view: 'all',
        sort: 'queue',
        direction: 'desc',
        paging: 'pages',
        page: 1,
        pageSize: 25,
      },
      'csrf-1',
    );
    expect(screen.getByText('Sorted by List order: Newest first')).toBeTruthy();
  });

  it('opens on the review view with the oldest submission first', async () => {
    serve(() => pageOf([row(1)]));
    mount({ initialTab: 'awaiting-review' });
    await screen.findByText('Store 1');
    expect(lastBody()).toMatchObject({ view: 'awaiting-review', direction: 'asc' });
    expect(screen.getByText('Sorted by List order: Oldest first')).toBeTruthy();
  });

  it('shows the columns, the owner, the status with its kind, health, area and dates', async () => {
    serve(() =>
      pageOf([
        row(1, {
          health: { day: '2026-11-10', kind: 'scored', band: 'at-risk', score: 55 },
          origin: 'invitation',
        }),
        row(2, { storeName: null, slug: null, status: 'hidden', owner: null, health: null }),
      ]),
    );
    mount();
    await screen.findByText('Store 1');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Store',
      'Owner',
      'Status',
      'Health',
      'Service area',
      'Submitted',
      'Last change',
      'Actions',
    ]);
    expect(screen.getByRole('link', { name: 'Store 1' }).getAttribute('href')).toBe(
      `/sellers/${id(1)}`,
    );
    expect(screen.getByText('owner1@example.com')).toBeTruthy();
    expect(screen.getByText('Invited by MondaPac')).toBeTruthy();
    expect(screen.getByText('At risk · 55')).toBeTruthy();
    expect(screen.getByText('Not measured yet')).toBeTruthy();
    expect(screen.getAllByText('New application').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Greater Brisbane').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'No store name yet' })).toBeTruthy();
    expect(screen.getAllByText('Not given').length).toBeGreaterThan(0);
  });

  it('shows the seven views with their counts and sends the view', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    for (const name of [
      'Awaiting review (3)',
      'Incomplete (4)',
      'All sellers (9)',
      'Changes needed (3)',
      'Not approved (2)',
      'Approved (7)',
      'Suspended (1)',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    for (const [name, view] of [
      ['Incomplete (4)', 'incomplete'],
      ['Awaiting review (3)', 'awaiting-review'],
      ['Changes needed (3)', 'changes-needed'],
      ['Not approved (2)', 'not-approved'],
      ['Approved (7)', 'approved'],
      ['Suspended (1)', 'suspended'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(lastBody()['view']).toBe(view));
      expect(lastBody()['page']).toBe(1);
    }
  });

  it('hides the state views and the owner column without identity.seller-access.view', async () => {
    serve(() => pageOf([row(1, { status: 'hidden', owner: null })], { stateCounts: null }));
    mount();
    await screen.findByText('Store 1');
    expect(screen.getByRole('button', { name: 'All sellers (9)' })).toBeTruthy();
    for (const name of [/^Changes needed/, /^Not approved/, /^Approved/, /^Suspended/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('columnheader', { name: 'Owner' })).toBeNull();
    expect(screen.getByText('-')).toBeTruthy();
  });

  it('has newest-first state views with no search, filter or sort, and an empty state each', async () => {
    serve((body) =>
      body['view'] === 'approved' ? pageOf([], { tab: 'approved' }) : pageOf([row(1)]),
    );
    mount();
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'store' },
    });
    await waitFor(() => expect(lastBody()['q']).toBe('store'));
    fireEvent.click(screen.getByRole('button', { name: 'Approved (7)' }));
    expect(await screen.findByText('No approved sellers yet.')).toBeTruthy();
    expect(lastBody()).toMatchObject({ view: 'approved', sort: 'queue', direction: 'desc' });
    expect(lastBody()).not.toHaveProperty('q');
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    expect(screen.queryByText(/^Sorted by/)).toBeNull();
  });

  it('has an empty state for a view and one for a search', async () => {
    serve(() => pageOf([], { counts: { ...COUNTS, all: 0 } }));
    mount();
    expect(await screen.findByRole('heading', { name: 'No sellers yet.' })).toBeTruthy();
  });

  it('keeps no button in a row but the Actions menu, with Open leading to the file', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const body = screen.getAllByRole('row')[1]!;
    expect(
      within(body)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Actions for Store 1']);
    fireEvent.click(within(body).getByRole('button', { name: 'Actions for Store 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/sellers/${id(1)}`);
  });

  it('offers no Actions item for a row the API names no action for', async () => {
    serve(() => pageOf([row(1, { actions: [] })]));
    mount();
    await screen.findByText('Store 1');
    const body = screen.getAllByRole('row')[1]!;
    const menu = within(body).queryByRole('button', { name: 'Actions for Store 1' });
    if (menu !== null) fireEvent.click(menu);
    expect(screen.queryByRole('menuitem', { name: 'Open' })).toBeNull();
  });

  it('shows a labelled card line per column for the phone layout', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    for (const label of ['Owner', 'Health', 'Service area', 'Submitted', 'Last change']) {
      expect(document.querySelector(`[data-label="${label}"]`)).not.toBeNull();
    }
  });

  it('renders a store name as text, not markup', async () => {
    serve(() => pageOf([row(1, { storeName: '<img src=x onerror=alert(1)>' })]));
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says the health could not be read in a notice and in the cells', async () => {
    serve(() => pageOf([row(1, { health: null })], { healthUnavailable: true }));
    mount();
    await screen.findByText('Store 1');
    expect(screen.getByText(/Seller health could not be loaded/)).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText('Not measured yet')).toBeNull();
  });

  it('formats instants in UTC and shows the Sellers nav item only with sellers.seller.view', () => {
    expect(formatInstant('2026-10-09T23:30:00.000Z', 'en-AU')).toContain('UTC');
    expect(formatInstant(null, 'en-AU')).toBe('-');
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('sellers');
    expect(ids(['sellers.seller.view'])).toContain('sellers');
  });
});

describe('Sellers list: search, filter, sort', () => {
  it('sends the search after the typing pause as a chip that can be removed', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'Sto' } });
    await waitFor(() => expect(lastBody()['q']).toBe('Sto'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Sto"' }));
    await waitFor(() => expect(lastBody()).not.toHaveProperty('q'));
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('sends nothing for one character and says so', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const before = call.mock.calls.length;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'S' } });
    expect(await screen.findByText('Type at least 2 characters to search.')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(call.mock.calls.length).toBe(before);
  });

  it('shows a hint, not rows, when the search names too many sellers', async () => {
    serve((body) => (body['q'] === undefined ? pageOf([row(1)]) : 'too-broad'));
    mount();
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'ab' },
    });
    expect(
      await screen.findByText('That search matches too many sellers. Type more letters.'),
    ).toBeTruthy();
    expect(screen.queryByText('Store 1')).toBeNull();
  });

  it('filters by submission kind on the review view, as chips that can be removed', async () => {
    serve(() => pageOf([row(1)]));
    mount({ initialTab: 'awaiting-review' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Field' }), {
      target: { value: 'kind' },
    });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Value' }), {
      target: { value: 'identity-change' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastBody()['kind']).toBe('identity-change'));
    expect(screen.getByText('Submission is Change request')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Submission is Change request' }),
    );
    await waitFor(() => expect(lastBody()).not.toHaveProperty('kind'));
  });

  it('sends outsideArea as a JSON boolean on the incomplete view, and the area on any file view', async () => {
    serve(() => pageOf([row(1)]));
    mount({ initialTab: 'incomplete' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    let panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Field' }), {
      target: { value: 'outsideArea' },
    });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Value' }), {
      target: { value: 'true' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastBody()['outsideArea']).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const fields = within(panel).getAllByRole('combobox', { name: 'Field' });
    fireEvent.change(fields[fields.length - 1]!, { target: { value: 'areaCode' } });
    const values = within(panel).getAllByRole('combobox', { name: 'Value' });
    fireEvent.change(values[values.length - 1]!, { target: { value: 'gold-coast' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastBody()['areaCode']).toBe('gold-coast'));
    expect(lastBody()['outsideArea']).toBe(true);
    expect(screen.getByText('Service area is Gold Coast')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(lastBody()).not.toHaveProperty('areaCode'));
    expect(lastBody()).not.toHaveProperty('outsideArea');
  });

  it('drops a filter another view does not take when the view changes', async () => {
    serve(() => pageOf([row(1)]));
    mount({ initialTab: 'awaiting-review' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Field' }), {
      target: { value: 'kind' },
    });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Value' }), {
      target: { value: 'onboarding' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastBody()['kind']).toBe('onboarding'));
    fireEvent.click(screen.getByRole('button', { name: 'All sellers (9)' }));
    await waitFor(() => expect(lastBody()['view']).toBe('all'));
    expect(lastBody()).not.toHaveProperty('kind');
  });

  it('sorts by store name on a file view, with the direction each field reads', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Store name' }));
    await waitFor(() => expect(lastBody()).toMatchObject({ sort: 'name', direction: 'asc' }));
    expect(screen.getByText('Sorted by Store name: A to Z')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Sort' })).getByRole('radio', { name: 'Z to A' }),
    );
    await waitFor(() => expect(lastBody()['direction']).toBe('desc'));
  });
});

describe('Sellers list: paging', () => {
  it('shows the range and total with page numbers, and asks for the page chosen', async () => {
    serve((body) => pageOf([row(1)], { total: 60, page: body['page'] as number }));
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    expect(screen.getByText('1–1 of 60 sellers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastBody()['page']).toBe(3));
  });

  it('sends the rows per page as a number and goes back to page 1', async () => {
    serve(() => pageOf([row(1)], { total: 60 }));
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(lastBody()).toMatchObject({ pageSize: 50, page: 1 }));
  });

  it('shows Previous and Next with no total or range, and sends paging=prev-next', async () => {
    serve((body) => openPage([row(1)], body['page'] === 1, body['page'] as number));
    mount({ paging: 'prev-next' });
    await screen.findByText('Store 1');
    expect(lastBody()['paging']).toBe('prev-next');
    expect(screen.queryByText(/of \d+ sellers/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastBody()['page']).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(lastBody()['page']).toBe(1));
  });
});

describe('Sellers list: states', () => {
  it('shows a retry after a failed first load, and loads again', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("We couldn't load the sellers. Try again.")).toBeTruthy();
    serve(() => pageOf([row(1)]));
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByText('Store 1')).toBeTruthy();
  });

  it('shows the loading state before the first answer', () => {
    call.mockImplementation(() => new Promise(() => undefined));
    mount();
    expect(screen.getAllByText('Loading sellers...').length).toBeGreaterThan(0);
  });

  it('shows the no-access words on 403, and goes to the session-ended page on 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText("You don't have access to the seller list.")).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('says a refused query cannot be run, with no retry', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Try again/i })).toBeNull();
  });
});

describe('Sellers list: selection and Export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
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
  const sent: { url: string; init: RequestInit }[] = [];
  const answerWith = (make: () => Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        sent.push({ url, init });
        return Promise.resolve(make());
      }),
    );
  };
  const lastSent = () => {
    const entry = sent[sent.length - 1]!;
    return {
      url: entry.url,
      method: entry.init.method,
      csrf: (entry.init.headers as Record<string, string>)['x-csrf-token'],
      body: JSON.parse(entry.init.body as string) as Record<string, unknown>,
    };
  };
  const names: string[] = [];
  let click: { mockRestore: () => void };

  beforeEach(() => {
    sent.length = 0;
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

  it('has Export as the only bulk item, off until a row is selected', async () => {
    serve(() => pageOf([row(1), row(2)]));
    mount();
    await screen.findByText('Store 1');
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Store 1' }));
    expect(bulk()).toHaveProperty('disabled', false);
    expect(screen.getByText('1 seller selected')).toBeTruthy();
    fireEvent.click(bulk());
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
  });

  it('POSTs the ticked ids alone, with the CSRF token and the seller-id column when shown', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:sellers-columns',
      JSON.stringify(['status', 'seller-id']),
    );
    serve(() => pageOf([row(1), row(2)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Incomplete (4)' }));
    await waitFor(() => expect(lastBody()['view']).toBe('incomplete'));
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    answerWith(() => new Response('﻿Store\r\nr1\r\nr2\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(lastSent()).toEqual({
      url: '/api/sellers/admin/sellers/export',
      method: 'POST',
      csrf: 'csrf-1',
      body: { format: 'csv', columns: 'seller-id', ids: `${id(1)},${id(2)}` },
    });
    expect(names).toEqual([expect.stringMatching(/^sellers-.*\.csv$/)]);
  });

  it('after "Select all matching" POSTs the selector and the sort, and no ids or paging', async () => {
    serve(() => pageOf([row(1)], { total: 143 }));
    mount({ paging: 'pages', initialTab: 'incomplete' });
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'Store' },
    });
    await waitFor(() => expect(lastBody()['q']).toBe('Store'));
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching sellers are selected')).toBeTruthy();
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b]), {
          status: 200,
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="sellers-2026-11-18.xlsx"',
          },
        }),
    );
    confirm(await openExport(), 'XLSX');
    expect(await screen.findByText('Exported 143 rows.')).toBeTruthy();
    expect(lastSent().body).toEqual({
      format: 'xlsx',
      view: 'incomplete',
      q: 'Store',
      sort: 'queue',
      direction: 'desc',
    });
    expect(names).toEqual(['sellers-2026-11-18.xlsx']);
  });

  it('offers "Select all matching" without a number with Previous and next, and none when all fits', async () => {
    serve(() => openPage([row(1)], true));
    mount({ paging: 'prev-next' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching sellers are selected')).toBeTruthy();
    cleanup();
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    expect(screen.queryByRole('button', { name: /Select all .*matching/ })).toBeNull();
  });

  it('says how many rows are too many on a 413, with the most and the total', async () => {
    serve(() => pageOf([row(1)], { total: 12000 }));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    fireEvent.click(screen.getByRole('button', { name: /^Select all .* matching/ }));
    answerWith(
      () =>
        new Response(
          JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        ),
    );
    confirm(await openExport());
    expect(await screen.findByText(/Too many rows to export/)).toBeTruthy();
    expect(screen.getAllByText(/10,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/12,000/).length).toBeGreaterThan(0);
  });

  it('says so when the export search is too broad', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Store 1' }));
    answerWith(
      () =>
        new Response(JSON.stringify({ code: 'search.too-broad' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    confirm(await openExport());
    expect(await screen.findByText(messages['sales-lists'].export.error['too-broad'])).toBeTruthy();
  });
});

describe('Sellers list: saved filter tabs', () => {
  const SAVED = 'lists/admin/saved-filters';
  const item = (view: string, over: Record<string, unknown> = {}) => ({
    id: '0190a000-0000-7000-8000-0000000000e1',
    listKey: 'admin.sellers.list',
    name: 'Brisbane reviews',
    visibility: 'me',
    payload: { v: 1, view, filters: { kind: 'onboarding' }, sort: 'name', direction: 'asc' },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });
  const savedWith =
    (items: unknown[], canShare = false): SavedRoute =>
    (_method, path) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: path.startsWith(SAVED) ? { items, canShare } : {},
      } as never);

  it('adds the saved filter as a tab and opens it with its view, filters and sort', async () => {
    serve(() => pageOf([row(1)]), savedWith([item('awaiting-review')]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Brisbane reviews' }));
    await waitFor(() => expect(lastBody()).toMatchObject({ view: 'awaiting-review' }));
    expect(lastBody()).toMatchObject({ sort: 'name', direction: 'asc', page: 1 });
    expect(lastBody()).toMatchObject({ kind: 'onboarding' });
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
  });

  it('offers Save filter... on a built-in view that shows something to keep', async () => {
    serve(() => pageOf([row(1)]), savedWith([], true));
    mount();
    await screen.findByText('Store 1');
    expect(screen.queryByRole('button', { name: /^Save filter/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Awaiting review/ }));
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  it('keeps the controls hidden while the saved-filter route cannot answer', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('hides a saved state-view filter from an admin without identity.seller-access.view', async () => {
    serve(
      () => pageOf([row(1)], { stateCounts: null }),
      savedWith([item('approved', { payload: { v: 1, view: 'approved' } })]),
    );
    mount();
    await screen.findByText('Store 1');
    expect(screen.queryByRole('button', { name: 'Brisbane reviews' })).toBeNull();
  });

  it('shows a saved state-view filter when the state views are known', async () => {
    serve(
      () => pageOf([row(1)]),
      savedWith([item('approved', { payload: { v: 1, view: 'approved' } })]),
    );
    mount();
    await screen.findByText('Store 1');
    expect(await screen.findByRole('button', { name: 'Brisbane reviews' })).toBeTruthy();
  });

  it('clears the search when a saved tab opens, and leaves it out of the save summary', async () => {
    serve(() => pageOf([row(1)]), savedWith([item('awaiting-review')], true));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: /^Awaiting review/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abc' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/abc/)).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'Brisbane reviews' }));
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe(''));
  });

  it('falls back to the built-in view when the active saved tab is deleted', async () => {
    let items: unknown[] = [item('awaiting-review')];
    serve(
      () => pageOf([row(1)]),
      (method, path) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: path.startsWith(SAVED) && method === 'GET' ? { items, canShare: false } : {},
        } as never),
    );
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Brisbane reviews' }));
    await waitFor(() => expect(lastBody()).toMatchObject({ view: 'awaiting-review' }));
    items = [];
    fireEvent.click(screen.getByRole('button', { name: 'Manage filters' }));
    await screen.findByRole('dialog');
  });

  it('works in a synthetic market too', async () => {
    serve(() => pageOf([row(1)]), savedWith([item('awaiting-review')]));
    render(
      <NextIntlClientProvider locale="en-NZ" messages={messages}>
        <SellersList csrfToken="csrf-1" paging="pages" accountId="acc-1" marketId="ZZ" />
      </NextIntlClientProvider>,
    );
    await screen.findByText('Store 1');
    expect(await screen.findByRole('button', { name: 'Brisbane reviews' })).toBeTruthy();
  });
});

describe('Sellers list: columns and saved filters', () => {
  it('hides a column the admin turned off, from this browser storage', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:sellers-columns',
      JSON.stringify(['status', 'area']),
    );
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Store',
      'Status',
      'Service area',
      'Actions',
    ]);
  });

  it('builds the list body from the query: state views send no search or filter', () => {
    expect(
      listBody(
        {
          ...DEFAULT_QUERY,
          view: 'approved',
          q: 'abc',
          filters: { areaCode: 'x' },
        },
        'pages',
      ),
    ).toEqual({
      view: 'approved',
      sort: 'queue',
      direction: 'desc',
      paging: 'pages',
      page: 1,
      pageSize: 25,
    });
  });

  it('round-trips the saved-filter payload, dropping what the view does not take', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'awaiting-review' as const,
      direction: 'asc' as const,
      filters: { kind: 'onboarding', areaCode: 'gold-coast' },
    };
    expect(somethingToSave(query)).toBe(true);
    expect(somethingToSave(DEFAULT_QUERY)).toBe(false);
    const payload = payloadOf(query);
    expect(payload).toEqual({
      v: 1,
      view: 'awaiting-review',
      filters: { kind: 'onboarding', areaCode: 'gold-coast' },
    });
    expect(queryOf(payload)).toMatchObject({
      view: 'awaiting-review',
      direction: 'asc',
      filters: query.filters,
    });
    expect(
      queryOf({ v: 1, view: 'approved', filters: { kind: 'onboarding' }, sort: 'name' }),
    ).toMatchObject({ view: 'approved', filters: {}, sort: 'name' });
  });
});
