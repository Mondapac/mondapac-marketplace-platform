// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { reviewProblemOf } from './review-errors.ts';
import { ReviewQueueView } from './review-queue-view.tsx';
import { offerRowsOf, type ReviewRow, type RevisionRow } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
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
    expect(query.has('sort')).toBe(false);
    vi.unstubAllGlobals();
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
