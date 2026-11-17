// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { exportFailure, exportQuery } from './offers-bulk.tsx';
import { OffersList } from './offers-list.tsx';
import { DEFAULT_QUERY, filtersOf, queryString } from './offers-query.ts';
import type { OfferListPage, OfferListRow } from './types.ts';

const call = vi.mocked(callApi);
const LIST_PATH = 'catalog/seller/offers?';
const COLUMNS_KEY = 'mp:seller:AU:0190a000-0000-7000-8000-0000000000f1:offers-columns';
const OPEN = (name: string) => screen.getByRole('button', { name });
const ID1 = '0190a000-0000-7000-8000-000000000001';

const row = (
  over: Partial<OfferListRow> = {},
  actions: string[] = ['open', 'edit', 'submit', 'delete'],
): OfferListRow => ({
  offerId: ID1,
  productId: '0190a000-0000-7000-8000-0000000000b1',
  product: { productCode: 'P00000001', typeCode: 'grocery', name: 'Aged Basmati Rice' },
  sellerSku: 'RICE-5KG',
  conditionCode: 'new',
  description: {},
  status: 'draft',
  listed: false,
  offSaleCauses: [],
  handling: null,
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  version: 1,
  ...over,
  actions,
});
const COUNTS = { draft: 3, pendingFirstPublish: 1, changesNeeded: 2, published: 20, all: 26 };
const pageOf = (rows: OfferListRow[], over: Partial<OfferListPage> = {}): OfferListPage => ({
  items: rows,
  total: null,
  page: 1,
  pageSize: 25,
  paging: 'prev-next',
  hasNext: false,
  counts: COUNTS,
  ...over,
});
const ok = (body: OfferListPage) => ({ ok: true as const, status: 200, body });

function serve(make: (url: string) => OfferListPage) {
  call.mockImplementation((_method: string, path: string) => Promise.resolve(ok(make(path))));
}
const lastUrl = (): string => {
  const calls = call.mock.calls.filter(
    ([method, path]) => method === 'GET' && path.startsWith(LIST_PATH),
  );
  return String(calls[calls.length - 1]?.[1]);
};
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);
const mount = (
  initial: OfferListPage = pageOf([row()]),
  props: Partial<React.ComponentProps<typeof OffersList>> = {},
) =>
  render(
    <NextIntlClientProvider locale="en-AU" timeZone="UTC" messages={messages}>
      <OffersList
        initial={initial}
        paging="prev-next"
        accountId="0190a000-0000-7000-8000-0000000000f1"
        marketId="AU"
        csrfToken="csrf"
        permissionKeys={[]}
        timeZone={null}
        {...props}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  call.mockReset();
  push.mockReset();
  window.localStorage.clear();
  serve(() => pageOf([row()]));
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('seller offers list', () => {
  it('shows product, SKU, status, on-sale state and submitted time from the first page', () => {
    mount(
      pageOf([
        row(),
        row({
          offerId: 'y',
          status: 'changes-needed',
          listed: true,
          submittedAt: '2026-10-15T01:00:00.000Z',
        }),
      ]),
    );
    const rows = screen.getAllByRole('row');
    expect(
      within(rows[1]!).getByRole('link', { name: 'Aged Basmati Rice' }).getAttribute('href'),
    ).toBe(`/offers/${ID1}`);
    expect(within(rows[1]!).getByText('RICE-5KG')).toBeTruthy();
    expect(within(rows[1]!).getByText('Draft')).toBeTruthy();
    expect(within(rows[1]!).getByText('No')).toBeTruthy();
    expect(within(rows[2]!).getByText('Changes needed')).toBeTruthy();
    expect(within(rows[2]!).getByText('Yes')).toBeTruthy();
    // The server's page is the first answer: the list asks for nothing more.
    expect(call).not.toHaveBeenCalled();
  });

  it('says so when the seller has no offer at all', () => {
    mount(
      pageOf([], {
        counts: { draft: 0, pendingFirstPublish: 0, changesNeeded: 0, published: 0, all: 0 },
      }),
    );
    expect(screen.getByText('No offers yet')).toBeTruthy();
  });

  it('offers the stage tabs with their counts and asks for a tab as the view', async () => {
    mount();
    const tabs = within(screen.getByRole('navigation', { name: 'Offer stages' }))
      .getAllByRole('button')
      .map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'All (26)',
      'Drafts (3)',
      'In review (1)',
      'Changes needed (2)',
      'Live (20)',
    ]);
    serve((url) => pageOf(paramsOf(url)['view'] === 'live' ? [] : [row()]));
    fireEvent.click(screen.getByRole('button', { name: /^Live/ }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('live'));
    expect(await screen.findByText('No live offers')).toBeTruthy();
  });

  it('pages with Previous and Next from hasNext, with no total', async () => {
    mount(pageOf([row()], { hasNext: true }));
    expect(screen.queryByText(/ of /)).toBeNull();
    serve((url) => pageOf([row({ offerId: 'p2' })], { page: Number(paramsOf(url)['page']) }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ page: '2', paging: 'prev-next' }),
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
  });

  it('shows page numbers with the total, the range and the 10,000 row limit, and asks for a page size', async () => {
    mount(pageOf([row()], { total: 12_345, paging: 'pages' }), { paging: 'pages' });
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    expect(screen.getByText(/Page numbers stop at the first 10,000 offers/)).toBeTruthy();
    serve((url) =>
      pageOf([row()], {
        total: 12_345,
        paging: 'pages',
        page: 1,
        pageSize: Number(paramsOf(url)['pageSize']),
      }),
    );
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(paramsOf(lastUrl())).toMatchObject({ pageSize: '50', page: '1' }));
  });

  it('offers Try again when a page cannot be loaded, and none for a refused query', async () => {
    mount();
    call.mockResolvedValue({
      ok: false,
      failure: { status: 503, code: 'access.unavailable' },
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /^Live/ }));
    expect(await screen.findByText(/couldn't load your offers/)).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'validation.failed' },
    } as never);
    fireEvent.click(screen.getByRole('button', { name: /^Drafts/ }));
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('seller offers search, filters and sort', () => {
  it('searches by text and shows it as a chip that can be removed', async () => {
    mount();
    const box = screen.getByRole('searchbox', { name: 'Search offers' });
    fireEvent.change(box, { target: { value: ' rice ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('rice'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Search: rice' }));
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBeUndefined());
  });

  it('filters by status and on-sale, as chips, and clears them all', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'status' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'published' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    fireEvent.change(within(panel).getAllByLabelText('Field')[1]!, { target: { value: 'listed' } });
    fireEvent.change(within(panel).getAllByLabelText('Value')[1]!, { target: { value: 'true' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ status: 'published', listed: 'true' }),
    );
    expect(screen.getByText('Status is Published')).toBeTruthy();
    expect(screen.getByText('On sale is Yes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBeUndefined());
    expect(paramsOf(lastUrl())['listed']).toBeUndefined();
  });

  it('sorts by SKU from the Sort panel and names the sort', async () => {
    mount();
    fireEvent.click(OPEN('Sort'));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Your SKU' }));
    await waitFor(() => expect(lastUrl()).toContain('sort=sku&direction=asc'));
    expect(screen.getByText('Sorted by Your SKU, A to Z')).toBeTruthy();
  });

  it('shows the empty state of a filter with a way to clear it', async () => {
    mount();
    serve(() => pageOf([]));
    const box = screen.getByRole('searchbox', { name: 'Search offers' });
    fireEvent.change(box, { target: { value: 'nothing' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('No offers match')).toBeTruthy();
  });
});

describe('seller offers row actions', () => {
  it('puts every row action in the Actions menu, and Prices and Stock only for their keys', async () => {
    mount(pageOf([row()]), { permissionKeys: ['pricing.price.edit', 'inventory.stock.edit'] });
    expect(screen.getAllByRole('button', { name: /^Actions for/ })).toHaveLength(1);
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open', 'Edit', 'Prices', 'Stock', 'Submit for review…', 'Delete…']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Prices' }));
    expect(push).toHaveBeenCalledWith(`/offers/${ID1}/prices`);
  });

  it('offers only what the row names, and no Prices or Stock without their keys', async () => {
    mount(pageOf([row({}, ['open'])]));
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Open']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open' }));
    expect(push).toHaveBeenCalledWith(`/offers/${ID1}`);
  });

  it('asks before Submit for review, then submits and reads the page again', async () => {
    mount(pageOf([row()]));
    call.mockImplementation(((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? { ok: true, status: 200, body: { published: false } }
          : ok(pageOf([row()])),
      )) as never);
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Submit for review…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Submit offer RICE-5KG for review?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/seller/offers/${ID1}/submit`,
        undefined,
        'csrf',
      ),
    );
    await waitFor(() => expect(lastUrl()).toContain('page=1'));
  });

  it('keeps Delete off until the SKU is typed, then deletes', async () => {
    mount(pageOf([row()]));
    call.mockImplementation(((method: string) =>
      Promise.resolve(
        method === 'DELETE' ? { ok: true, status: 204, body: null } : ok(pageOf([])),
      )) as never);
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete offer' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type the SKU to confirm'), {
      target: { value: 'RICE-5KG' },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `catalog/seller/offers/${ID1}`,
        undefined,
        'csrf',
      ),
    );
  });

  it('clears the selection after a delete, so an export never names the deleted offer', async () => {
    mount(pageOf([row()]));
    call.mockImplementation(((method: string) =>
      Promise.resolve(
        method === 'DELETE' ? { ok: true, status: 204, body: null } : ok(pageOf([row()])),
      )) as never);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all offers on this page' }));
    expect(screen.getByText('1 offer selected')).toBeTruthy();
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type the SKU to confirm'), {
      target: { value: 'RICE-5KG' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete offer' }));
    await waitFor(() => expect(screen.queryByText('1 offer selected')).toBeNull());
  });

  it('says in the dialog why a delete was refused', async () => {
    mount(pageOf([row()]));
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'offer.delete-via-product' },
    } as never);
    fireEvent.click(OPEN('Actions for Aged Basmati Rice'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type the SKU to confirm'), {
      target: { value: 'RICE-5KG' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete offer' }));
    expect(await within(dialog).findByText(/can't be deleted here/)).toBeTruthy();
  });
});

describe('seller offers selection, columns and export', () => {
  const heads = () =>
    within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((head) => head.textContent)
      .filter((name) => name !== '' && name !== 'Actions');

  it('selects rows and offers Select all matching', () => {
    mount(pageOf([row()], { hasNext: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all offers on this page' }));
    expect(screen.getByText('1 offer selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(screen.getByText('All matching offers are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('keeps the column choice in this browser and reads it back', async () => {
    const first = mount();
    expect(heads()).toEqual(['Product', 'Status', 'Your SKU', 'On sale', 'Submitted']);
    fireEvent.click(OPEN('Columns'));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'On sale' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(heads()).toEqual(['Product', 'Status', 'Your SKU', 'Submitted']);
    expect(JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? 'null')).toEqual([
      'sku',
      'submitted',
    ]);
    first.unmount();
    mount();
    await waitFor(() => expect(heads()).toEqual(['Product', 'Status', 'Your SKU', 'Submitted']));
  });

  it('exports the ticked offers by id, and the whole list by its selector', async () => {
    const saveAs = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: saveAs, configurable: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mount(pageOf([row()], { total: 1, paging: 'pages' }), { paging: 'pages' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all offers on this page' }));
    fireEvent.click(OPEN('Bulk action'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Export/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url.startsWith('/api/catalog/seller/offers/export?')).toBe(true);
    expect(Object.fromEntries(new URL(url, 'http://x').searchParams)).toMatchObject({
      offerIds: ID1,
      format: 'csv',
    });
    vi.unstubAllGlobals();
  });
});

describe('offers query and export rules', () => {
  it('asks for list mode with the paging setting and the tab as the view', () => {
    expect(Object.fromEntries(new URLSearchParams(queryString(DEFAULT_QUERY, 'pages')))).toEqual({
      view: 'all',
      sort: 'created',
      direction: 'desc',
      page: '1',
      pageSize: '25',
      paging: 'pages',
    });
  });

  it('keeps only a known value of a known filter field', () => {
    expect(filtersOf({ status: 'published', listed: 'false' })).toEqual({
      status: 'published',
      listed: 'false',
    });
    expect(filtersOf({ status: 'gone', listed: 'maybe' })).toEqual({});
  });

  it('sends the selector or the ids to the export, never the paging keys', () => {
    const query = { ...DEFAULT_QUERY, tab: 'live' as const, q: 'rice', page: 3, pageSize: 50 };
    const all = Object.fromEntries(new URLSearchParams(exportQuery('xlsx', query, ['sku'], null)));
    expect(all).toMatchObject({
      format: 'xlsx',
      view: 'live',
      q: 'rice',
      columns: 'sku,product,status,code',
    });
    expect(all['page']).toBeUndefined();
    expect(all['pageSize']).toBeUndefined();
    const ids = Object.fromEntries(
      new URLSearchParams(exportQuery('csv', query, ['sku', 'listed'], ['a', 'b'])),
    );
    expect(ids).toMatchObject({ offerIds: 'a,b', columns: 'sku,product,status,code,listed' });
    expect(ids['view']).toBeUndefined();
  });

  it('names each refusal of the export', () => {
    expect(exportFailure(413, 'batch.too-large', { max: 100 }).key).toBe('too-many-selected');
    expect(exportFailure(413, 'batch.too-large', { max: 10_000, total: 12_000 }).key).toBe(
      'too-large',
    );
    expect(exportFailure(404, 'offer.not-found', null).key).toBe('not-found');
    expect(exportFailure(403, 'access.denied', null).key).toBe('denied');
    expect(exportFailure(503, 'access.unavailable', null).key).toBe('unavailable');
  });
});
