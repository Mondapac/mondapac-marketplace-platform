// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

const { inner, saved } = vi.hoisted(() => ({
  inner: vi.fn<(method: string, path: string, ...rest: unknown[]) => Promise<unknown>>(),
  saved: { items: [] as unknown[] },
}));
// Only this list's own key is answered; any other key is not found. Saved filters are served apart from the queue's own calls the tests count.
vi.mock('../api/client.ts', () => ({
  callApi: (method: string, path: string, ...rest: unknown[]) =>
    path.startsWith('lists/admin/saved-filters')
      ? Promise.resolve(
          method === 'GET' &&
            path !== 'lists/admin/saved-filters?listKey=admin.catalog.review-queue'
            ? { ok: false, failure: { status: 404, code: 'not-found' } }
            : { ok: true, status: 200, body: { items: saved.items, canShare: false } },
        )
      : inner(method, path, ...rest),
}));

import { reviewProblemOf } from './review-errors.ts';
import { ReviewQueueView } from './review-queue-view.tsx';
import { offerRowsOf, type ReviewRow, type RevisionRow } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = inner;
const ID = '0190a000-0000-7000-8000-0000000000c1';
const assign = vi.fn();
const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  kind: 'offer-first-publication',
  offerId: ID,
  version: 3,
  sellerId: '0190a000-0000-7000-8000-0000000000f1',
  productId: '0190a000-0000-7000-8000-0000000000d1',
  product: { productCode: 'P1', typeCode: 'grocery', name: 'Olive oil' },
  sellerSku: 'OIL-1',
  conditionCode: 'new',
  description: { 'en-AU': 'Cold pressed', ar: '' },
  handling: 'SEALED_ORIGINAL',
  submittedAt: '2026-10-14T01:00:00.000Z',
  ...over,
});

const revision = (over: Partial<RevisionRow> = {}): RevisionRow => ({
  kind: 'product-revision',
  productId: '0190a000-0000-7000-8000-0000000000d2',
  revisionId: '0190a000-0000-7000-8000-0000000000e2',
  revisionNo: 2,
  version: 5,
  sellerId: '0190a000-0000-7000-8000-0000000000f1',
  storeName: 'Corner Store',
  product: { productCode: 'P2', typeCode: 'grocery', name: 'Dates' },
  firstPublication: false,
  reasons: ['name', 'primary-image'],
  requiredChecks: ['a', 'b'],
  hasImages: true,
  warnings: [],
  submittedAt: '2026-10-13T01:00:00.000Z',
  ...over,
});

const TOTALS = { 'product-revision': 12, 'offer-first-publication': 3 };
/** The queue's answer: rows, what the filters keep, the whole queue per kind. */
const answer = (items: unknown[], total: number = items.length) =>
  ({
    ok: true,
    status: 200,
    body: {
      items,
      nextAfterId: null,
      total,
      totals: TOTALS,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: false,
    },
  }) as never;
const offerAnswer = (actions: string[] = ['approve', 'request-changes']) =>
  answer([{ ...row(), actions }]);

function mount(tab: 'offer' | 'revision' = 'offer') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewQueueView
        tab={tab}
        paging="pages"
        accountId="0190a000-0000-7000-8000-000000000099"
        marketId="AU"
        zone="Australia/Brisbane"
        csrfToken="csrf-1"
      />
    </NextIntlClientProvider>,
  );
}
const fail = (status: number, code: string) =>
  call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
/** Opens the row's Actions menu and picks an item: no row action is a button in the row. */
async function act(name: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}
const queueCalls = () =>
  call.mock.calls.filter(
    ([m, path]) => m === 'GET' && path.startsWith('catalog/admin/review-queue'),
  );

beforeEach(() => {
  vi.clearAllMocks();
  saved.items = [];
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('review queue lists', () => {
  it('reads the Offers kind and shows both tab counts from the answer', async () => {
    call.mockResolvedValue(offerAnswer());
    mount('offer');
    expect(await screen.findByText('Olive oil')).toBeTruthy();
    const query = new URLSearchParams(queueCalls()[0]![1].split('?')[1]);
    expect(query.get('kind')).toBe('offer-first-publication');
    expect(query.get('q')).toBeNull();
    expect(query.get('sort')).toBe('submitted');
    expect(query.get('direction')).toBe('asc');
    expect(await screen.findByRole('link', { name: 'Product revisions (12)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Offers (3)' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('shows only the saved filters of its own kind, and opens one with its filters', async () => {
    const filter = (n: number, name: string, kind: string, extra = {}) => ({
      id: `0190a000-0000-7000-8000-00000000010${n}`,
      listKey: 'admin.catalog.review-queue',
      name,
      visibility: 'me',
      payload: { v: 1, filters: { kind, ...extra }, sort: 'submitted', direction: 'asc' },
      ownedByMe: true,
      canManage: true,
    });
    saved.items = [
      filter(1, 'New products', 'product-revision', { firstPublication: 'true' }),
      filter(2, 'Offers of one seller', 'offer-first-publication'),
    ];
    call.mockResolvedValue(answer([revision()]));
    mount('revision');
    fireEvent.click(await screen.findByRole('button', { name: 'New products' }));
    expect(screen.queryByRole('button', { name: 'Offers of one seller' })).toBeNull();
    await waitFor(() => {
      const query = new URLSearchParams(queueCalls().at(-1)![1].split('?')[1]);
      expect(query.get('kind')).toBe('product-revision');
      expect(query.get('firstPublication')).toBe('true');
      expect(query.get('sort')).toBe('submitted');
      expect(query.get('direction')).toBe('asc');
    });
  });

  it('lists the revisions with the change and photo filters, and opens a review from the menu', async () => {
    call.mockResolvedValue(answer([revision()]));
    mount('revision');
    expect(await screen.findByText('Dates')).toBeTruthy();
    expect(new URLSearchParams(queueCalls()[0]![1].split('?')[1]).get('kind')).toBe(
      'product-revision',
    );
    expect(screen.getByText('Corner Store')).toBeTruthy();
    expect(screen.getByText('2 checks')).toBeTruthy();
    await act('Dates', 'Open review…');
    expect(assign).toHaveBeenCalledWith(
      '/review/products/0190a000-0000-7000-8000-0000000000d2/revisions/0190a000-0000-7000-8000-0000000000e2',
    );
  });

  it.each([
    ['offer', 'Olive oil'],
    ['revision', 'Dates'],
  ] as const)(
    'filters the %s list by when it was submitted, as instants on the Brisbane day, and takes it off again',
    async (tab, name) => {
      call.mockResolvedValue(tab === 'offer' ? offerAnswer() : answer([revision()]));
      mount(tab);
      await screen.findByText(name);
      fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
      fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'submitted' } });
      fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'today' } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      const asked = () =>
        queueCalls().map(([, path]) => new URLSearchParams(String(path).split('?')[1]));
      await waitFor(() => expect(asked().some((p) => p.has('submittedFrom'))).toBe(true));
      // Midnight on the Brisbane clock (UTC+10, no daylight saving) is 14:00 UTC, and Today is one
      // day long: never the UTC day.
      const brisbaneDay = (q: URLSearchParams) => {
        expect(q.get('submittedFrom')).toMatch(/T14:00:00(\.000)?Z$/);
        expect(q.get('submittedTo')).toMatch(/T14:00:00(\.000)?Z$/);
        expect(
          Date.parse(q.get('submittedTo') ?? '') - Date.parse(q.get('submittedFrom') ?? ''),
        ).toBe(24 * 3600 * 1000);
        expect(q.has('submitted')).toBe(false);
      };
      brisbaneDay(asked().find((p) => p.has('submittedFrom')) as URLSearchParams);
      fireEvent.click(await screen.findByRole('button', { name: /Remove filter Submitted is/ }));
      await waitFor(() => expect(asked().at(-1)?.has('submittedFrom')).toBe(false));
    },
  );

  it('exports with the submitted range as the same instants the list asked for', async () => {
    call.mockResolvedValue(offerAnswer());
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="offers-for-review.csv"' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    mount('offer');
    await screen.findByText('Olive oil');
    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'submitted' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'today' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(queueCalls().some(([, path]) => String(path).includes('submittedFrom'))).toBe(true),
    );
    const row = (await screen.findByText('Olive oil')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export offers' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String((fetchMock.mock.calls as unknown as string[][])[0]?.[0]);
    expect(url.startsWith('/api/catalog/admin/review-queue/export?')).toBe(true);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('kind')).toBe('offer-first-publication');
    expect(query.get('submittedFrom')).toMatch(/T14:00:00(\.000)?Z$/);
    expect(query.get('submittedTo')).toMatch(/T14:00:00(\.000)?Z$/);
    expect(query.has('submitted')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('exports the current kind from the Bulk action menu, oldest first, with no sort sent', async () => {
    call.mockResolvedValue(offerAnswer());
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="offers-for-review.csv"' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    mount('offer');
    const row = (await screen.findByText('Olive oil')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export offers' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String((fetchMock.mock.calls as unknown as string[][])[0]?.[0]);
    expect(url.startsWith('/api/catalog/admin/review-queue/export?')).toBe(true);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('kind')).toBe('offer-first-publication');
    expect(query.get('format')).toBe('csv');
    expect(query.has('direction')).toBe(false);
    for (const key of ['sort', 'page', 'pageSize', 'paging', 'q'])
      expect(query.has(key)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('exports the revisions kind', async () => {
    call.mockResolvedValue(answer([revision()]));
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="product-revisions.csv"' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    mount('revision');
    const row = (await screen.findByText('Dates')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export product revisions' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String((fetchMock.mock.calls as unknown as string[][])[0]?.[0]);
    expect(new URLSearchParams(url.split('?')[1]).get('kind')).toBe('product-revision');
    vi.unstubAllGlobals();
  });

  const bulkAnswer = (
    action: string,
    results: unknown[],
    counts = { done: 1, skipped: 0, failed: 0 },
  ) => ({ ok: true, status: 200, body: { action, counts, results } }) as never;
  const bulkWrites = () => call.mock.calls.filter(([m]) => m === 'POST');

  it('approves the ticked Offers together and sends their ids and versions', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST' ? bulkAnswer('approve', [{ id: ID, outcome: 'done' }]) : offerAnswer(),
      ),
    );
    mount('offer');
    const tr = (await screen.findByText('Olive oil')).closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 1 offer?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1 offer' }));
    expect(await within(dialog).findByText('1 row decided, 0 skipped.')).toBeTruthy();
    expect(bulkWrites()).toEqual([
      [
        'POST',
        'catalog/admin/review-queue/bulk-decide',
        { action: 'approve', items: [{ id: ID, version: 3 }], kind: 'offer' },
        'csrf-1',
      ],
    ]);
  });

  it('sends the ticked revisions back with one reason, naming each revision', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? bulkAnswer('request-changes', [{ id: revision().productId, outcome: 'done' }])
          : answer([revision()]),
      ),
    );
    mount('revision');
    const tr = (await screen.findByText('Dates')).closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send back ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back 1 product revision?' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Send back 1 product revision',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Reason/ }), {
      target: { value: 'photos' },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await within(dialog).findByText('1 row decided, 0 skipped.');
    expect(bulkWrites()[0]).toEqual([
      'POST',
      'catalog/admin/review-queue/bulk-decide',
      {
        action: 'request-changes',
        items: [{ id: revision().productId, revisionId: revision().revisionId, version: 5 }],
        kind: 'revision',
        reasonCode: 'photos',
      },
      'csrf-1',
    ]);
  });

  it('tells which revisions need manual checks when a bulk approval skips them', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? bulkAnswer(
              'approve',
              [{ id: revision().productId, outcome: 'skipped', reason: 'review.checks-missing' }],
              { done: 0, skipped: 1, failed: 0 },
            )
          : answer([revision()]),
      ),
    );
    mount('revision');
    const tr = (await screen.findByText('Dates')).closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 1 product revision?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1 product revision' }));
    expect(
      await within(dialog).findByText(/1 revision needs manual checks, so it was not approved/),
    ).toBeTruthy();
    expect(bulkWrites()[0]?.[2]).toEqual({
      action: 'approve',
      items: [{ id: revision().productId, revisionId: revision().revisionId, version: 5 }],
      kind: 'revision',
    });
  });

  it('sends the ticked Offers back with one of the Offer reasons', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? bulkAnswer('request-changes', [{ id: ID, outcome: 'done' }])
          : offerAnswer(),
      ),
    );
    mount('offer');
    const tr = (await screen.findByText('Olive oil')).closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send back ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back 1 offer?' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Reason/ }), {
      target: { value: 'handling-unclear' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send back 1 offer' }));
    await within(dialog).findByText('1 row decided, 0 skipped.');
    expect(bulkWrites()[0]?.[2]).toEqual({
      action: 'request-changes',
      items: [{ id: ID, version: 3 }],
      kind: 'offer',
      reasonCode: 'handling-unclear',
    });
  });

  it('keeps the dialog open and says nothing was decided when the bulk call is refused', async () => {
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? { ok: false, failure: { status: 413, code: 'batch.too-large' } }
          : offerAnswer(),
      ),
    );
    mount('offer');
    const tr = (await screen.findByText('Olive oil')).closest('tr') as HTMLElement;
    fireEvent.click(within(tr).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 1 offer?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1 offer' }));
    expect(await within(dialog).findByText('At most 50 rows can be decided at once.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Approve 1 offer?' })).toBeTruthy();
    expect(bulkWrites()).toHaveLength(1);
  });

  it('shows the empty state of an empty queue', async () => {
    call.mockResolvedValue(answer([]));
    mount('offer');
    expect(await screen.findByText('No offers are waiting for review.')).toBeTruthy();
  });

  it('offers only the decisions the API names for the row', async () => {
    call.mockResolvedValue(offerAnswer([]));
    mount('offer');
    await screen.findByText('Olive oil');
    expect(screen.queryByRole('button', { name: 'Actions for Olive oil' })).toBeNull();
  });

  it('approves from the menu with the version the reviewer saw, and the list reads again', async () => {
    call.mockResolvedValueOnce(offerAnswer());
    mount('offer');
    await act('Olive oil', 'Approve…');
    expect(await screen.findByText('Cold pressed')).toBeTruthy();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    call.mockResolvedValue(answer([]));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/offers/${ID}/approve`,
        { version: 3 },
        'csrf-1',
      ),
    );
    await expectToast('Offer approved and published.');
    expect(await screen.findByText('No offers are waiting for review.')).toBeTruthy();
  });

  it('needs a reason to send back, then sends it with the version', async () => {
    call.mockResolvedValueOnce(offerAnswer());
    mount('offer');
    await act('Olive oil', 'Send back…');
    const submit = await screen.findByRole('button', { name: 'Send back' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'handling-unclear' } });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    call.mockResolvedValue(offerAnswer());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/admin/offers/${ID}/request-changes`,
        { version: 3, reasonCode: 'handling-unclear' },
        'csrf-1',
      ),
    );
    await expectToast(/Offer sent back/);
  });

  it('keeps the dialog on a stale answer and closes it when the Offer is no longer pending', async () => {
    call.mockResolvedValueOnce(offerAnswer());
    mount('offer');
    await act('Olive oil', 'Approve…');
    fail(409, 'conflict.stale');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/changed the offer meanwhile/)).toBeTruthy();
    fail(409, 'offer.not-pending-review');
    call.mockResolvedValue(answer([]));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await expectToast('This offer is no longer waiting for review.', 'error');
    await waitFor(() => expect(screen.queryByText('Cold pressed')).toBeNull());
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    call.mockResolvedValueOnce(offerAnswer());
    mount('offer');
    await act('Olive oil', 'Approve…');
    fail(401, 'session.invalid');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('offerRowsOf', () => {
  it('keeps the Offer rows in order and leaves product revision rows out', () => {
    const second = row({ offerId: '0190a000-0000-7000-8000-0000000000c2' });
    const items = [
      { kind: 'product-revision' as const },
      row(),
      { kind: 'product-revision' as const },
      second,
    ];
    expect(offerRowsOf(items).map((r) => r.offerId)).toEqual([ID, second.offerId]);
    expect(offerRowsOf([{ kind: 'product-revision' }])).toEqual([]);
  });
});

describe('reviewProblemOf and nav', () => {
  it('maps codes to message keys', () => {
    expect(reviewProblemOf({ status: 409, code: 'offer.not-pending-review' })).toEqual({
      key: 'catalog.review.error.gone',
      gone: true,
    });
    expect(reviewProblemOf({ status: 422, code: 'claim-text.refused' }).key).toBe(
      'catalog.review.error.claim-text',
    );
    expect(reviewProblemOf({ status: 0, code: 'network' }).key).toBe(
      'catalog.review.error.unavailable',
    );
  });
  it('shows the nav item only with catalog.product.view', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids(['catalog.product.view'])).toContain('review-queue');
    expect(ids([])).not.toContain('review-queue');
  });
});
