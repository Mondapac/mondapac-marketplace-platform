// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Toaster, toast } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { HealthQueue } from './health-queue.tsx';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  exportColumnIds,
  queryString,
  DEFAULT_QUERY,
} from './health-list-query.ts';
import type { HealthQueuePage, HealthQueueRow } from './health-types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, over: Partial<HealthQueueRow> = {}): HealthQueueRow => ({
  sellerId: id(n),
  storeName: `Store ${n}`,
  slug: `store-${n}`,
  day: '2026-11-10',
  score: 10 + n,
  lowestMetric: 'late-ready',
  actions: ['open'],
  ...over,
});
const COUNTS = {
  all: 7,
  'seller-cancellations': 1,
  'late-ready': 3,
  'customer-rating': 1,
  'lost-disputes': 1,
  reports: 1,
};
const pageOf = (items: HealthQueueRow[], over: Partial<HealthQueuePage> = {}): HealthQueuePage => ({
  items,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  total: items.length,
  hasNext: false,
  counts: COUNTS,
  truncated: false,
  ...over,
});
/** The answer of Previous and next: no total. */
const openPage = (items: HealthQueueRow[], hasNext = false, page = 1) =>
  pageOf(items, { total: null, paging: 'prev-next', hasNext, page });

type Answer = HealthQueuePage | 'fail' | 'denied' | 'unauthenticated' | 'refused';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => Answer) {
  call.mockImplementation((_method, path) => {
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'sellers.unavailable' } });
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
const urls = () => call.mock.calls.map((entry) => entry[1]);
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(options: { paging?: 'pages' | 'prev-next'; marketId?: string } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <HealthQueue
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId={options.marketId ?? 'AU'}
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

describe('Needs a look list: rows and views', () => {
  it('asks for page 1, worst score first, with the Market paging mode', async () => {
    serve(() => pageOf([row(1), row(2)]));
    mount();
    await screen.findByText('Store 1');
    expect(paramsOf(lastUrl())).toEqual({
      sort: 'score',
      direction: 'asc',
      paging: 'pages',
      page: '1',
      pageSize: '25',
    });
    expect(lastUrl().startsWith('sellers/admin/health-queue/list?')).toBe(true);
    expect(screen.getByText('Sorted by Score: Lowest first')).toBeTruthy();
  });

  it('shows the default columns, a link to the seller file and the score badge', async () => {
    serve(() => pageOf([row(1), row(3, { storeName: null, slug: null, lowestMetric: 'bogus' })]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Seller',
      'Score',
      'Lowest measure',
      'Measured',
      'Actions',
    ]);
    expect(screen.getByRole('link', { name: 'Store 1' }).getAttribute('href')).toBe(
      `/sellers/${id(1)}`,
    );
    expect(screen.getByText('Unhealthy · 11')).toBeTruthy();
    expect(screen.getAllByText('Orders ready late').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Unnamed store' })).toBeTruthy();
    expect(screen.getAllByText('10 Nov 2026').length).toBe(2);
  });

  it('shows a labelled card line per column for the phone layout, and no button in a row but the menu', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    for (const label of ['Lowest measure', 'Measured']) {
      expect(document.querySelector(`[data-label="${label}"]`)).not.toBeNull();
    }
    const body = screen.getAllByRole('row')[1]!;
    expect(
      within(body)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Actions for Store 1']);
    expect(within(body).queryByRole('button', { name: /open$/i })).toBeNull();
  });

  it('shows the views with their counts and sends the view for a measure', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.getByRole('button', { name: 'All (7)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Orders ready late (3)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reports (1)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('reports'));
    expect(paramsOf(lastUrl())['page']).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'All (7)' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('view'));
  });

  it('has an empty state for the queue and one for a view', async () => {
    serve((url) =>
      url.includes('view=reports')
        ? pageOf([], { counts: { ...COUNTS, all: 3 } })
        : pageOf([], { counts: { ...COUNTS, all: 0 } }),
    );
    mount();
    expect(await screen.findByRole('heading', { name: 'No seller needs a look' })).toBeTruthy();
    expect(screen.getByText('No seller is in the Unhealthy band right now.')).toBeTruthy();
    serve((url) =>
      url.includes('view=reports') ? pageOf([]) : pageOf([row(1)], { counts: { ...COUNTS } }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(
      await screen.findByRole('heading', {
        name: 'No seller is unhealthy because of reports',
      }),
    ).toBeTruthy();
  });
});

describe('Needs a look list: search, filter, sort', () => {
  it('sends the search after the typing pause or Enter, as a chip that can be removed', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: 'Sto' } });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('Sto'));
    expect(screen.getByRole('button', { name: 'Remove filter Search: "Sto"' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: "Sto"' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('sends nothing for one character and says so', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const before = urls().length;
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'S' } });
    expect(await screen.findByText('Type at least 2 characters to search.')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(urls().length).toBe(before);
  });

  it('filters by score range, as chips that can be removed, and clears all', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '5' } });
    fireEvent.change(within(panel).getByLabelText('To'), { target: { value: '30' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ minScore: '5', maxScore: '30' }),
    );
    expect(screen.getByText('Score from is 5')).toBeTruthy();
    expect(screen.getByText('Score up to is 30')).toBeTruthy();
    expect(screen.getByText('1 seller matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Score from is 5' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('minScore'));
    expect(paramsOf(lastUrl())['maxScore']).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('maxScore'));
  });

  it('refuses a score that is not 0 to 100, and a range that ends before it starts', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    const before = urls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '101' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByText('Use a whole number from 0 to 100.')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '50' } });
    fireEvent.change(within(panel).getByLabelText('To'), { target: { value: '40' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(within(panel).getByText('The end of the range is before its start.')).toBeTruthy();
    expect(urls().length).toBe(before);
  });

  it('sorts by store name and by measured day, with the direction each field reads', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    let panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Store name' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'name', direction: 'asc' }),
    );
    fireEvent.click(within(panel).getByRole('radio', { name: 'Measured' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'day', direction: 'desc' }),
    );
    expect(screen.getByText('Sorted by Measured: Newest first')).toBeTruthy();
    panel = screen.getByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => expect(paramsOf(lastUrl())['direction']).toBe('asc'));
  });
});

describe('Needs a look list: paging', () => {
  it('shows the range and total with page numbers, and asks for the page chosen', async () => {
    serve((url) =>
      pageOf([row(1)], { total: 60, page: Number(paramsOf(url)['page']), pageSize: 25 }),
    );
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    expect(screen.getByText('1–1 of 60 sellers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('3'));
  });

  it('sends the rows per page and goes back to page 1', async () => {
    serve(() => pageOf([row(1)], { total: 60 }));
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(paramsOf(lastUrl())).toMatchObject({ pageSize: '50', page: '1' }));
  });

  it('shows Previous and Next with no total or range, and sends paging=prev-next', async () => {
    serve((url) =>
      openPage([row(1)], paramsOf(url)['page'] === '1', Number(paramsOf(url)['page'])),
    );
    mount({ paging: 'prev-next' });
    await screen.findByText('Store 1');
    expect(paramsOf(lastUrl())['paging']).toBe('prev-next');
    expect(screen.queryByText(/of \d+ sellers/)).toBeNull();
    expect(screen.queryByText(/sellers? match/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('1'));
  });

  it('goes back to the last page that has rows when the page asked for is empty', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '3'
        ? pageOf([], { total: 30, page: 3 })
        : pageOf([row(1)], { total: 30, page: Number(paramsOf(url)['page']) }),
    );
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await screen.findByText('Store 1');
  });
});

describe('Needs a look list: selection and Export', () => {
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

  it('sends the ticked ids and the shown optional columns, with no zone, filter, sort or paging', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:seller-health-columns',
      JSON.stringify(['measured', 'seller-id', 'score']),
    );
    serve(() => pageOf([row(1), row(2)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Reports (1)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('reports'));
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    answerWith(() => new Response('﻿Store\r\nr1\r\nr2\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(sent()).toEqual({
      path: '/api/sellers/admin/health-queue/export',
      params: { format: 'csv', columns: 'day,seller-id', ids: `${id(1)},${id(2)}` },
    });
    expect(names).toEqual([expect.stringMatching(/^sellers-needing-attention-.*\.csv$/)]);
  });

  it('leaves out the columns key when no optional export column is shown', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:seller-health-columns',
      JSON.stringify(['score']),
    );
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Store 1' }));
    answerWith(() => new Response('Store\r\nr1\r\n', { status: 200, headers: CSV }));
    confirm(await openExport());
    await screen.findByText('Exported 1 row.');
    expect(sent().params).toEqual({ format: 'csv', ids: id(1) });
  });

  it('after "Select all matching" sends the selector and the sort, and no ids or paging', async () => {
    serve(() => pageOf([row(1)], { total: 143 }));
    mount({ paging: 'pages' });
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'Store' },
    });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('Store'));
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
            'content-disposition':
              'attachment; filename="sellers-needing-attention-2026-11-18.xlsx"',
          },
        }),
    );
    confirm(await openExport(), 'XLSX');
    expect(await screen.findByText('Exported 143 rows.')).toBeTruthy();
    expect(sent().params).toEqual({
      format: 'xlsx',
      q: 'Store',
      sort: 'score',
      direction: 'asc',
      columns: 'day',
    });
    expect(names).toEqual(['sellers-needing-attention-2026-11-18.xlsx']);
  });

  it('offers "Select all matching" without a number with Previous and next', async () => {
    serve(() => openPage([row(1)], true));
    mount({ paging: 'prev-next' });
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching sellers are selected')).toBeTruthy();
  });

  it('does not offer Select all matching when everything fits on the page', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    expect(screen.queryByRole('button', { name: /Select all .*matching/ })).toBeNull();
  });

  it('says when the file would miss sellers because the queue was cut', async () => {
    serve(() => pageOf([row(1)], { total: 200, truncated: true }));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all sellers on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 200 matching' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 'batch.too-large', details: { max: 200 } }), {
            status: 413,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    confirm(await openExport());
    expect(
      await screen.findByText('Too many rows to export. Narrow the filter or select fewer rows.'),
    ).toBeTruthy();
  });
});

describe('Needs a look list: notice, actions, columns', () => {
  it('shows the notice when more sellers were unhealthy than the queue holds', async () => {
    serve(() => pageOf([row(1)], { truncated: true }));
    mount();
    expect(await screen.findByText(/Only the 200 sellers with the worst scores/)).toBeTruthy();
  });

  it('shows no notice when the queue is whole', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.queryByText(/Only the 200 sellers/)).toBeNull();
  });

  it('opens the seller file from the Actions menu', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Store 1' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/sellers/${id(1)}`);
  });

  it('offers only what the row names: an unknown id or none gives no menu', async () => {
    serve(() => pageOf([row(1, { actions: ['mystery'] }), row(2, { actions: [] })]));
    mount();
    await screen.findByText('Store 1');
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('keeps the column choice in this browser per Market and account, in the chosen order', async () => {
    serve(() => pageOf([row(1)]));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).getAllByText('Always shown')).toHaveLength(1);
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Seller ID' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Score' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(
      JSON.parse(window.localStorage.getItem('mp:admin:AU:acc-1:seller-health-columns')!),
    ).toEqual(['lowest', 'measured', 'seller-id']);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      '',
      'Seller',
      'Lowest measure',
      'Measured',
      'Seller ID',
      'Actions',
    ]);
  });

  it('keys the stored choice by Market (second fixture ZZ)', async () => {
    window.localStorage.setItem(
      'mp:admin:ZZ:acc-1:seller-health-columns',
      JSON.stringify(['seller-id']),
    );
    serve(() => pageOf([row(1)]));
    mount({ marketId: 'ZZ' });
    await screen.findByRole('columnheader', { name: 'Seller ID' });
    expect(screen.queryByRole('columnheader', { name: 'Score' })).toBeNull();
  });

  it('cleans a stored choice and maps the export columns', () => {
    expect(cleanColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(cleanColumns(['seller-id', 'x', 'seller-id', 'score'])).toEqual(['seller-id', 'score']);
    expect(exportColumnIds(OPTIONAL_COLUMNS)).toEqual(['day', 'seller-id']);
    expect(queryString({ ...DEFAULT_QUERY, q: 'a' }, 'pages')).not.toContain('q=');
  });
});

describe('Needs a look list: states', () => {
  it('shows a loading status with the search box on the first load', async () => {
    call.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByText('Loading sellers...')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    serve(() => 'fail');
    mount();
    expect(await screen.findByText("We couldn't load the sellers. Try again.")).toBeTruthy();
    serve(() => pageOf([row(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Store 1')).toBeTruthy();
  });

  it('keeps the rows and shows a banner when a refresh fails, without actions on them', async () => {
    serve((url) => (url.includes('view=reports') ? 'fail' : pageOf([row(1)])));
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: /^Reports/ }));
    expect(await screen.findByText("We couldn't load the sellers. Try again.")).toBeTruthy();
    expect(screen.getByText('Store 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('says the query was refused, without a Try again that could never work', async () => {
    serve((url) => (url.includes('minScore') ? 'refused' : pageOf([row(1)])));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount();
    await screen.findByText('Store 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '5' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    warn.mockRestore();
  });

  it('says there is no access on a 403, with a link home', async () => {
    serve(() => 'denied');
    mount();
    expect(
      await screen.findByText('Ask an administrator for the permission to view sellers.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to home' }).getAttribute('href')).toBe('/');
  });

  it('goes to the sign-in page on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('says nothing matches a filter, with Clear all to start again', async () => {
    serve((url) => (url.includes('q=') ? pageOf([]) : pageOf([row(1)])));
    mount();
    await screen.findByText('Store 1');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'zz' },
    });
    expect(await screen.findByRole('heading', { name: 'No seller matches' })).toBeTruthy();
    const clear = screen
      .getAllByRole('button', { name: 'Clear all' })
      .find((button) => button.closest('td') !== null)!;
    fireEvent.click(clear);
    expect(await screen.findByText('Store 1')).toBeTruthy();
  });
});
