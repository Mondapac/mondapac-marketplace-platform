// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { cleanColumns } from './queue-columns.ts';
import { queryString } from './queue-query.ts';
import { QueueList } from './queue-list.tsx';
import { payloadOf, queryOf, somethingToSave } from './queue-saved.ts';
import { queueSearchRoute } from './queue-search.ts';
import { DEFAULT_QUERY, type QueueListPage, type QueueListRow } from './queue-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const SELLER = '0190a000-0000-7000-8000-000000000300';
const CERT = '0190a000-0000-7000-8000-0000000000c1';
const certId = (n: number) => `0190a000-0000-7000-8000-0000000000c${n}`;
const STORE = 'Logan Road Grocer';
const LIST = 'certification/admin/seller-certificates/list';

const TYPES = [
  { code: 'halal', name: 'Halal' },
  { code: 'kosher', name: 'Kosher' },
];

const row = (over: Partial<QueueListRow> = {}): QueueListRow => ({
  certificateId: CERT,
  version: 3,
  submissionId: '0190a000-0000-7000-8000-0000000000d1',
  submissionNo: 2,
  kind: 'resubmission',
  typeCode: 'halal',
  sellerId: SELLER,
  storeName: STORE,
  issuerName: 'Halal Certification Authority',
  submittedAt: '2026-11-10T01:30:00.000Z',
  actions: ['open', 'decide'],
  ...over,
});
const COUNTS = { all: 9, initial: 4, resubmission: 3, renewal: 2 };
const pageOf = (items: QueueListRow[], over: Partial<QueueListPage> = {}): QueueListPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: COUNTS,
  truncated: false,
  ...over,
});
/** The answer of Previous and next: no total. */
const noTotal = (items: QueueListRow[], hasNext = false, page = 1) =>
  pageOf(items, { total: null, paging: 'prev-next', hasNext, page });

type SavedRoute = (method: string, path: string) => Promise<never>;
/** Until a test says otherwise the saved-filter route is not there: the controls stay hidden. */
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({ ok: false, failure: { status: 404, code: 'not-found' } } as never);

type Answer = QueueListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => Answer, saved: SavedRoute = noSavedRoute) {
  call.mockImplementation((method, path) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path);
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
    if (result === 'refused') {
      return Promise.resolve({
        ok: false,
        failure: { status: 400, code: 'validation.failed', details: { fields: [] } },
      });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const urls = () =>
  call.mock.calls.map((entry) => entry[1]).filter((url) => !url.startsWith('lists/admin/'));
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    zone?: string;
    marketId?: string;
    sellerId?: string | null;
    types?: typeof TYPES;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <QueueList
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId={options.marketId ?? 'AU'}
        zone={options.zone ?? BRISBANE}
        types={options.types ?? TYPES}
        sellerId={options.sellerId ?? null}
        csrfToken="csrf-1"
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

describe('Certificate queue: page numbers', () => {
  it('asks for page 1 in review order and shows the header, views, rows and range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    expect(await screen.findByRole('link', { name: `${STORE}, seller 00000300` })).toBeTruthy();
    expect(paramsOf(urls()[0]!)).toEqual({
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'queue',
      direction: 'asc',
    });
    expect(urls()[0]!.startsWith(`${LIST}?`)).toBe(true);
    // The zone is no longer written on the page: it is in the Help panel, the account menu and the row times.
    expect(
      screen.queryByText(/(Times|Dates)( and days)?( are shown)?( are)? in [A-Z]/u),
    ).toBeNull();
    expect(screen.getByText('Sorted by Review order: Renewals first, then oldest')).toBeTruthy();
    expect(screen.getByText('1-1 of 143')).toBeTruthy();
    expect(screen.getByText('Halal')).toBeTruthy();
    expect(screen.getByText('Resubmitted')).toBeTruthy();
    expect(screen.getByText('Submission 2')).toBeTruthy();
    expect(screen.getByText('Halal Certification Authority')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: `${STORE}, seller 00000300` }).getAttribute('href'),
    ).toBe(`/sellers/${SELLER}`);
    // The saved filter controls are hidden while their route cannot answer.
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('shows the view counts and sends the kind as the view, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await screen.findByText(STORE);
    expect(screen.getByRole('button', { name: 'All (9)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'New (4)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resubmitted (3)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Renewal (2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('renewal'));
    expect(paramsOf(lastUrl())['page']).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'New (4)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('initial'));
    fireEvent.click(screen.getByRole('button', { name: 'All (9)' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('view'));
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

  it('sorts by Waiting since and Type, in either direction', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Waiting since' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=submitted&direction=asc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Newest first' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=submitted&direction=desc'));
    expect(screen.getByText('Sorted by Waiting since: Newest first')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Type' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=type&direction=asc'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Z to A' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=type&direction=desc'));
  });
});

describe('Certificate queue: second fixture ZZ', () => {
  it('follows the Market paging mode and the list zone', async () => {
    serve(() => noTotal([row()], true));
    mount({ marketId: 'ZZ', zone: 'Pacific/Auckland', paging: 'prev-next' });
    await screen.findByText(STORE);
    expect(paramsOf(urls()[0]!)).toMatchObject({ paging: 'prev-next', page: '1' });
    // The zone is no longer written on the page: it is in the Help panel, the account menu and the row times.
    expect(
      screen.queryByText(/(Times|Dates)( and days)?( are shown)?( are)? in [A-Z]/u),
    ).toBeNull();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);
  });

  it('shows page numbers with a total under page-number paging', async () => {
    serve(() => pageOf([row()], { total: 60 }));
    mount({ marketId: 'ZZ', zone: 'Pacific/Auckland' });
    await screen.findByText(STORE);
    expect(screen.getByText('1-1 of 60')).toBeTruthy();
    // The zone is no longer written on the page: it is in the Help panel, the account menu and the row times.
    expect(
      screen.queryByText(/(Times|Dates)( and days)?( are shown)?( are)? in [A-Z]/u),
    ).toBeNull();
  });
});

describe('Certificate queue: Previous and next', () => {
  it('sends paging=prev-next, keeps Sort, shows no total and walks the pages', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '2'
        ? noTotal([row({ storeName: 'Second Store' })], false, 2)
        : noTotal([row({ storeName: 'First Store' })], true),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText('First Store');
    expect(paramsOf(urls()[0]!)).toMatchObject({ paging: 'prev-next', page: '1' });
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy();
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Second Store');
    expect(paramsOf(lastUrl())).toMatchObject({ paging: 'prev-next', page: '2' });
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('First Store');
    expect(paramsOf(lastUrl())['page']).toBe('1');
  });

  it('offers "Select all matching" without a number', async () => {
    serve(() => noTotal([row()], true));
    mount({ paging: 'prev-next' });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching submissions are selected')).toBeTruthy();
  });
});

describe('Certificate queue: search', () => {
  const box = () => screen.getByRole('searchbox', { name: 'Search' });

  it('sends a certificate or submission id as q, lower-cased, with a chip that clears it', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(box().getAttribute('placeholder')).toBe('Certificate ID or submission ID');
    fireEvent.change(box(), { target: { value: ` ${CERT.toUpperCase()} ` } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(CERT));
    expect(screen.getByText(`ID is ${CERT}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Remove filter ID is ${CERT}` }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
    expect((box() as HTMLInputElement).value).toBe('');
  });

  it('asks for nothing from text that is not an id, and says what the box takes only after Enter', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const before = urls().length;
    fireEvent.change(box(), { target: { value: 'Logan' } });
    expect(screen.queryByText('Enter a full certificate ID or submission ID.')).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText('Enter a full certificate ID or submission ID.')).toBeTruthy();
    expect(urls()).toHaveLength(before);
  });

  it('searches the typed id after the typing pause', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.change(box(), { target: { value: CERT } });
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(CERT));
  });

  it('routes only a UUID v7, in any case', () => {
    expect(queueSearchRoute('')).toEqual({ kind: 'none' });
    expect(queueSearchRoute(` ${CERT.toUpperCase()} `)).toEqual({ kind: 'id', value: CERT });
    expect(queueSearchRoute('a8a7b3a4-4d2c-4f9b-8a1e-0123456789ab')).toEqual({ kind: 'invalid' });
    expect(queueSearchRoute('Logan')).toEqual({ kind: 'invalid' });
  });
});

describe('Certificate queue: filters', () => {
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

  it('offers Type with the type names and Submitted with the presets, and no Kind (it is a view)', async () => {
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
    ).toEqual(['Field', 'Type', 'Submitted']);
    fireEvent.change(field, { target: { value: 'type' } });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .slice(1),
    ).toEqual(['Halal', 'Kosher']);
  });

  it('offers no Type field to a reader who may not view types', async () => {
    serve(() => pageOf([row()]));
    mount({ types: [] });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    expect(
      within(within(panel).getByLabelText('Field'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Submitted']);
  });

  it('filters by type and submitted, as chips that can be removed one by one', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    await addCondition('type', 'kosher');
    apply(await addCondition('submitted', 'last-7-days', false));
    await waitFor(() => expect(paramsOf(lastUrl())['type']).toBe('kosher'));
    expect(paramsOf(lastUrl())['from']).toBeDefined();
    expect(paramsOf(lastUrl())['to']).toBeDefined();
    expect(screen.getByText('Type is Kosher')).toBeTruthy();
    expect(screen.getByText('Submitted is Last 7 days')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (2)' })).toBeTruthy();
    expect(screen.getByText('1 submission matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Submitted is Last 7 days' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('from'));
    expect(paramsOf(lastUrl())['type']).toBe('kosher');
  });

  it('reads the Submitted preset on the clock of the list zone, Brisbane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount({ zone: BRISBANE });
    await screen.findByText(STORE);
    apply(await addCondition('submitted', 'today'));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
  });

  it('shows a removable Seller chip when a link names one, with the store name', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(`Seller is ${STORE}`);
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    fireEvent.click(screen.getByRole('button', { name: `Remove filter Seller is ${STORE}` }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
  });

  it('clears the search, filters and seller together with Clear all, keeping the view', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    apply(await addCondition('type', 'halal'));
    await waitFor(() => expect(paramsOf(lastUrl())['type']).toBe('halal'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('type'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId');
    expect(paramsOf(lastUrl())['view']).toBe('renewal');
  });
});

describe('Certificate queue: truncated notice', () => {
  it('says the newest are not listed when more than 500 are waiting', async () => {
    serve(() => pageOf([row()], { truncated: true }));
    mount();
    await screen.findByText(STORE);
    expect(
      screen.getByText(/More than 500 submissions are waiting\. The list shows the oldest 500;/),
    ).toBeTruthy();
  });

  it('shows no notice when everything is listed', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    expect(screen.queryByText(/More than 500 submissions/)).toBeNull();
  });
});

describe('Certificate queue: row Actions menu', () => {
  const OPEN = (name: string) => screen.getByRole('button', { name });

  it('lists Open and Decide... when the row names both, and goes to the review page', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN(`Actions for the certificate of ${STORE}`));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open', 'Decide…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/certificates/${CERT}`);
    fireEvent.click(OPEN(`Actions for the certificate of ${STORE}`));
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Decide…' }),
    );
    expect(push).toHaveBeenLastCalledWith(`/certificates/${CERT}#rv-decision`);
  });

  it('offers only what the row names: Decide is absent without the approve key', async () => {
    serve(() => pageOf([row({ actions: ['open'] })]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN(`Actions for the certificate of ${STORE}`));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open']);
  });

  it('keeps a fixed order, ignores an unknown id, and has no menu without an action', async () => {
    serve(() =>
      pageOf([
        row({ actions: ['mystery', 'decide', 'open'] }),
        row({ certificateId: certId(2), storeName: 'Empty Menu Store', actions: [] }),
      ]),
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(OPEN(`Actions for the certificate of ${STORE}`));
    expect(
      within(await screen.findByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open', 'Decide…']);
    expect(
      screen.queryByRole('button', { name: 'Actions for the certificate of Empty Menu Store' }),
    ).toBeNull();
  });

  it('has no button inside a row besides the select box and the menu', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    const body = document.querySelector('tbody')!;
    const buttons = within(body).queryAllByRole('button');
    expect(
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual([`Actions for the certificate of ${STORE}`]);
    expect(
      within(body)
        .queryAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([`/sellers/${SELLER}`]);
  });
});

describe('Certificate queue: phone layout and text safety', () => {
  it('labels each cell for the card layout, with the seller as the title and the select-all bar', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    for (const label of ['Type', 'Issuer', 'Waiting since', 'Submission']) {
      expect(document.querySelector(`[data-label="${label}"]`)).not.toBeNull();
    }
    // The header row is hidden below 1024 px, so the phone has its own select-all bar.
    expect(document.querySelector('label.lg\\:hidden')).not.toBeNull();
    expect(document.querySelector('.max-lg\\:block')).not.toBeNull();
  });

  it('renders seller-entered text as plain text and names a seller that is not approved yet', async () => {
    serve(() =>
      pageOf([
        row({ storeName: '<img src=x onerror=alert(1)>' }),
        row({ certificateId: certId(2), storeName: null, typeCode: 'vegan', issuerName: null }),
      ]),
    );
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Not yet approved')).toBeTruthy();
    // A type this reader cannot name keeps its code.
    expect(screen.getByText('vegan')).toBeTruthy();
    expect(screen.getByText('Not named')).toBeTruthy();
  });
});

describe('Certificate queue: selection and Export', () => {
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

  it('has Export as the only bulk item (no bulk decision), off until a row is selected', async () => {
    serve(() => pageOf([row(), row({ certificateId: certId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(
      screen.getAllByRole('checkbox', { name: `Select the certificate of ${STORE}` })[0]!,
    );
    expect(screen.getByText('1 submission selected')).toBeTruthy();
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

  it('sends the ticked ids and the shown optional columns in order, and no filter, sort or page', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:certificate-queue-columns',
      JSON.stringify(['seller-id', 'submission-no']),
    );
    serve(() => pageOf([row(), row({ certificateId: certId(2) })]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    answerWith(() => new Response('﻿Type\r\nrow 1\r\nrow 2\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(fetched).toHaveLength(1);
    expect(sent()).toEqual({
      path: '/api/certification/admin/seller-certificates/export',
      params: {
        format: 'csv',
        columns: 'seller-id,submission-no',
        ids: `${certId(1)},${certId(2)}`,
      },
    });
    expect(names).toEqual([expect.stringMatching(/^certificate-queue-\d{4}-\d{2}-\d{2}\.csv$/)]);
  });

  it('sends the list selector and sort, and no ids, after "Select all matching"', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('renewal'));
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    expect(screen.getByText('All 143 matching submissions are selected')).toBeTruthy();
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            'content-type': XLSX,
            'content-disposition': 'attachment; filename="certificate-queue-2026-11-17.xlsx"',
          },
        }),
    );
    confirm(await openExport(), 'XLSX');
    expect(await screen.findByText('Exported 143 rows.')).toBeTruthy();
    const { params } = sent();
    expect(params).toEqual({
      format: 'xlsx',
      columns: 'submission-no',
      view: 'renewal',
      sort: 'queue',
      direction: 'asc',
    });
    expect(names).toEqual(['certificate-queue-2026-11-17.xlsx']);
  });

  it('does not offer "Select all matching" when more than 500 are waiting: ticked rows still export by id', async () => {
    serve(() => pageOf([row()], { total: 501, truncated: true }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    expect(screen.getByText('1 submission selected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Select all .* matching$/ })).toBeNull();
    answerWith(() => new Response('\uFEFFType\r\nrow 1\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(sent().params['ids']).toBe(CERT);
    expect(sent().params['view']).toBeUndefined();
  });

  it('says so when the API refuses an export with 413 batch.too-large', async () => {
    serve(() => pageOf([row()], { total: 500 }));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    answerWith(
      () =>
        new Response('{"statusCode":413,"code":"batch.too-large","details":{"max":500}}', {
          status: 413,
        }),
    );
    confirm(await openExport());
    expect(
      await screen.findByText('Too many rows to export. Narrow the filter or select fewer rows.'),
    ).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('exports the shown columns of the second fixture ZZ, read from its own preference key', async () => {
    window.localStorage.setItem(
      'mp:admin:ZZ:acc-1:certificate-queue-columns',
      JSON.stringify(['certificate-id']),
    );
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ', zone: 'Pacific/Auckland' });
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    answerWith(() => new Response('\uFEFFType\r\nrow 1\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(sent().params).toEqual({ format: 'csv', columns: 'certificate-id', ids: CERT });
  });

  it('does not keep the selection when the view changes', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findAllByText(STORE);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all submissions on this page' }));
    expect(screen.getByText('1 submission selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New (4)' }));
    await waitFor(() => expect(screen.queryByText('1 submission selected')).toBeNull());
  });
});

describe('Certificate queue: states', () => {
  it('shows skeleton rows with a loading status on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading certificates...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("The queue couldn't be loaded.")).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(STORE)).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('view=renewal') ? 'fail' : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    expect(await screen.findByText("The queue couldn't be loaded.")).toBeTruthy();
    expect(screen.getByText(STORE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
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
    expect(await screen.findByText("You don't have access to certificates.")).toBeTruthy();
    expect(screen.getByText(/needs the certificate view permission/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
  });

  it('says the query cannot be run on validation.failed, with no Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve((url) => (url.includes('view=renewal') ? 'refused' : pageOf([row()])));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    expect(
      await screen.findByText(
        "This search can't be run. Change the text or the filters, or clear them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(warn).toHaveBeenCalledWith('certificates.queue-list-refused', []);
    warn.mockRestore();
  });

  it('words an empty queue by view, and an empty filter result with Clear all', async () => {
    serve(() => pageOf([], { counts: { all: 0, initial: 0, resubmission: 0, renewal: 0 } }));
    mount();
    expect(await screen.findByText('No certificates are waiting for a decision.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (0)' }));
    expect(await screen.findByText('No renewals are waiting.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getAllByLabelText('Field')[0]!, { target: { value: 'type' } });
    fireEvent.change(within(panel).getAllByLabelText('Value')[0]!, { target: { value: 'halal' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No submissions match')).toBeTruthy();
    // Clear all is in the chip row and again in the empty state, which offers the same way out.
    expect(screen.getAllByRole('button', { name: 'Clear all' })).toHaveLength(2);
  });
});

describe('Certificate queue: column choice', () => {
  const KEY = 'mp:admin:AU:acc-1:certificate-queue-columns';

  it('shows Submission by default, and keeps the choice in this browser, per Market and account', async () => {
    serve(() => pageOf([row()]));
    mount();
    await screen.findByText(STORE);
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).getAllByText('Always shown')).toHaveLength(5);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Certificate ID' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual([
      'submission-no',
      'certificate-id',
    ]);
    expect(document.querySelector('[data-label="Certificate ID"]')).not.toBeNull();
  });

  it('reads the choice back, keyed by Market (second fixture ZZ)', async () => {
    window.localStorage.setItem('mp:admin:ZZ:acc-1:certificate-queue-columns', '["seller-id"]');
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ' });
    await screen.findByText(STORE);
    expect(document.querySelector('[data-label="Seller ID"]')).not.toBeNull();
    expect(document.querySelector('[data-label="Submission"]')).toBeNull();
  });

  it('cleans a stored choice to the export column ids, without repeats or unknown ids', () => {
    expect(cleanColumns(undefined)).toEqual(['submission-no']);
    expect(cleanColumns(['seller-id', 'seller-id', 'bogus', 'certificate-id'])).toEqual([
      'seller-id',
      'certificate-id',
    ]);
    expect(cleanColumns([])).toEqual([]);
  });
});

describe('Certificate queue: saved filters', () => {
  const SAVED = 'lists/admin/saved-filters';
  const item = {
    id: '0190a000-0000-7000-8000-0000000000e1',
    listKey: 'admin.certification.review-queue',
    name: 'Kosher renewals',
    visibility: 'me',
    payload: { v: 1, view: 'renewal', filters: { type: 'kosher' }, sort: 'submitted' },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  it('adds the saved filter as a tab of its own, and opens it with its view, filters and sort', async () => {
    serve(
      () => pageOf([row()]),
      (_method, path) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: path.startsWith(SAVED) ? { items: [item], canShare: false } : {},
        } as never),
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(await screen.findByRole('button', { name: 'Kosher renewals' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('renewal'));
    expect(paramsOf(lastUrl())).toMatchObject({
      type: 'kosher',
      sort: 'submitted',
      direction: 'asc',
      page: '1',
    });
    expect(screen.getByRole('button', { name: 'Manage filters' })).toBeTruthy();
    // A built-in tab opened from the saved one does not carry its filters or sort.
    fireEvent.click(screen.getByRole('button', { name: 'New (4)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('initial'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('type');
    expect(paramsOf(lastUrl())['sort']).toBe('queue');
  });

  it("keeps the built-in tabs' counts when a saved filter is open", async () => {
    serve(
      (url) =>
        pageOf([row()], {
          counts: url.includes('type=kosher')
            ? { all: 1, initial: 0, resubmission: 0, renewal: 1 }
            : COUNTS,
        }),
      (_method, path) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: path.startsWith(SAVED) ? { items: [item], canShare: false } : {},
        } as never),
    );
    mount();
    await screen.findByText(STORE);
    fireEvent.click(await screen.findByRole('button', { name: 'Kosher renewals' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toHaveProperty('type', 'kosher'));
    expect(await screen.findByRole('button', { name: 'New (4)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Renewal (2)' })).toBeTruthy();
  });

  it('offers Save filter... on a built-in tab only while a filter is active', async () => {
    serve(
      () => pageOf([row()]),
      () =>
        Promise.resolve({ ok: true, status: 200, body: { items: [], canShare: true } } as never),
    );
    mount();
    await screen.findByText(STORE);
    expect(screen.queryByRole('button', { name: /^Save filter/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Renewal (2)' }));
    // A tab on its own is a view, not a filter: Save filter… waits for a search or a filter.
    expect(screen.queryByRole('button', { name: /^Save filter/ })).toBeNull();
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: CERT } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  it('keeps only what a saved document may hold, both ways', () => {
    expect(somethingToSave(DEFAULT_QUERY)).toBe(false);
    const query = {
      ...DEFAULT_QUERY,
      view: 'renewal' as const,
      q: CERT,
      sellerId: SELLER,
      filters: { type: 'halal', submitted: 'today' as const },
      sort: 'type' as const,
      direction: 'desc' as const,
      page: 4,
    };
    expect(somethingToSave(query)).toBe(true);
    const payload = payloadOf(query);
    expect(payload).toEqual({
      v: 1,
      view: 'renewal',
      filters: { type: 'halal', submitted: 'today' },
      sort: 'type',
      direction: 'desc',
    });
    expect(queryOf(payload)).toEqual({
      ...DEFAULT_QUERY,
      view: 'renewal',
      filters: { type: 'halal', submitted: 'today' },
      sort: 'type',
      direction: 'desc',
    });
    // A value this page does not know is dropped, not sent.
    expect(queryOf({ v: 1, view: 'bogus' as never, filters: { type: 'Bad Code!' } })).toEqual(
      DEFAULT_QUERY,
    );
  });
});

describe('Certificate queue: query string', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };
  const params = (text: string) => Object.fromEntries(new URLSearchParams(text));

  it('sends no view for All and leaves out a search that is not an id', () => {
    expect(params(queryString({ ...DEFAULT_QUERY, q: 'Logan' }, context))).toEqual({
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'queue',
      direction: 'asc',
    });
  });

  it('sends the page, sort, view, type and seller as chosen', () => {
    expect(
      params(
        queryString(
          {
            ...DEFAULT_QUERY,
            view: 'initial',
            page: 3,
            sort: 'submitted',
            direction: 'desc',
            sellerId: SELLER,
            filters: { type: 'halal' },
          },
          { ...context, paging: 'prev-next' },
        ),
      ),
    ).toEqual({
      paging: 'prev-next',
      page: '3',
      pageSize: '25',
      sort: 'submitted',
      direction: 'desc',
      view: 'initial',
      type: 'halal',
      sellerId: SELLER,
    });
  });
});
