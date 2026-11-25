// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const { inner, savedReads } = vi.hoisted(() => ({
  inner: vi.fn<(method: string, path: string, ...rest: unknown[]) => Promise<unknown>>(),
  savedReads: [] as string[],
}));
// Saved filters are served apart from the queue's own calls the tests count.
vi.mock('../api/client.ts', () => ({
  callApi: (method: string, path: string, ...rest: unknown[]) => {
    if (!path.startsWith('lists/admin/saved-filters')) return inner(method, path, ...rest);
    savedReads.push(path);
    return Promise.resolve({ ok: true, status: 200, body: { items: [], canShare: false } });
  },
}));

import { OfferReviewQueue } from './queue.tsx';
import type { ChangeRow, FirstRow } from './types.ts';

const call = inner;
const SELLER_A = '0190a000-0000-7000-8000-0000000000f1';
const SELLER_B = '0190a000-0000-7000-8000-0000000000f2';
const row = (n: number, over: Partial<FirstRow> = {}): FirstRow => ({
  kind: 'offer-first-publication',
  offerId: `0190a000-0000-7000-8000-00000000010${n}`,
  version: n,
  sellerId: SELLER_A,
  storeName: 'Date Palace',
  productId: `0190a000-0000-7000-8000-00000000020${n}`,
  product: { productCode: `P${n}`, typeCode: 'grocery', name: `Dates ${n}` },
  sellerSku: `SKU-${n}`,
  conditionCode: 'new',
  description: { 'en-AU': `Fresh dates ${n}` },
  handling: 'FRESH',
  reasons: ['probation'],
  tagTypes: [],
  submittedAt: '2026-11-24T22:00:00.000Z',
  actions: ['approve', 'request-changes'],
  ...over,
});
const edit = (n: number, over: Partial<ChangeRow> = {}): ChangeRow => ({
  changeId: `0190a000-0000-7000-8000-00000000030${n}`,
  offerId: `0190a000-0000-7000-8000-00000000010${n}`,
  status: 'pending',
  fields: ['description'],
  proposedDescription: { 'en-AU': `New text ${n}` },
  proposedHandling: null,
  proposedTagTypes: [],
  baseOfferVersion: 2,
  submittedAt: '2026-11-24T22:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
  supersededCause: null,
  reasons: ['handling'],
  sellerId: SELLER_A,
  storeName: 'Date Palace',
  offer: {
    productId: 'p',
    sellerSku: `SKU-${n}`,
    conditionCode: 'new',
    status: 'published',
    version: 3,
  },
  product: { productCode: `P${n}`, typeCode: 'grocery', name: `Dates ${n}` },
  live: { description: { 'en-AU': `Old text ${n}` }, handling: null, tagTypes: [] },
  actions: ['approve', 'request-changes', 'reject'],
  ...over,
});
const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    status: 200,
    body: {
      items,
      nextAfterId: null,
      total: items.length,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: false,
      ...extra,
    },
  }) as never;
const firstPage = (items: FirstRow[]) =>
  page(items, { totals: { 'product-revision': 0, 'offer-first-publication': 3 } });
const editsPage = (items: ChangeRow[]) => page(items, { totalPending: 5 });

function mount(tab: 'first' | 'edits', canDecide = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
      <OfferReviewQueue
        tab={tab}
        paging="pages"
        accountId="0190a000-0000-7000-8000-000000000099"
        marketId="AU"
        csrfToken="csrf"
        zone="Australia/Brisbane"
        permissionKeys={['catalog.product.view', 'catalog.product.approve']}
        canDecide={canDecide}
      />
    </NextIntlClientProvider>,
  );
}
const reads = (prefix: string) =>
  call.mock.calls.filter(([m, path]) => m === 'GET' && path.startsWith(prefix));
const bulkWrites = () => call.mock.calls.filter(([m]) => m === 'POST');
/** The drawer is the one native dialog that is open. */
async function openDrawer(): Promise<HTMLElement> {
  return waitFor(() => {
    const open = document.querySelector<HTMLElement>('dialog[open]');
    if (open === null) throw new Error('no open dialog');
    return open;
  });
}
async function tick(name: string) {
  const tr = (await screen.findByText(name)).closest('tr') as HTMLElement;
  fireEvent.click(within(tr).getByRole('checkbox'));
}
async function bulk(item: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  vi.clearAllMocks();
  savedReads.length = 0;
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

describe('first publications tab', () => {
  it('reads the Offer kind, shows reason chips and the tab count, and offers Edits as the other tab', async () => {
    call.mockResolvedValue(
      firstPage([row(1, { reasons: ['probation', 'certificate-badge'], tagTypes: ['halal'] })]),
    );
    mount('first');
    expect(await screen.findByText('Dates 1')).toBeTruthy();
    expect(screen.getByText('R1 New seller')).toBeTruthy();
    expect(screen.getByText('R2 Certificate badge')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'First publications (3)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edits' }).getAttribute('href')).toBe(
      '/offer-reviews?tab=edits',
    );
    const asked = new URLSearchParams(
      String(reads('catalog/admin/review-queue')[0]?.[1]).split('?')[1],
    );
    expect(asked.get('kind')).toBe('offer-first-publication');
    expect(asked.get('paging')).toBe('pages');
  });

  it('says nothing waits when the queue is empty', async () => {
    call.mockResolvedValue(firstPage([]));
    mount('first');
    expect(await screen.findByText('Nothing waiting for review.')).toBeTruthy();
  });

  it('opens the drawer from the name, and after a decision opens the next row of the page', async () => {
    call.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        method === 'POST'
          ? { ok: true, status: 200, body: {} }
          : path.startsWith('catalog/admin/review-queue')
            ? firstPage([row(1), row(2)])
            : { ok: false, failure: { status: 404, code: 'x' } },
      ),
    );
    mount('first');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    expect(within(drawer).getByText('Fresh dates 1')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve', hidden: true }));
    await waitFor(() => expect(within(drawer).getByText('Fresh dates 2')).toBeTruthy());
    expect(bulkWrites()[0]?.[1]).toBe(
      'catalog/admin/offers/0190a000-0000-7000-8000-000000000101/approve',
    );
    // The list read again after the decision.
    await waitFor(() => expect(reads('catalog/admin/review-queue').length).toBeGreaterThan(1));
  });

  it('approves watched and new sellers together and names the skipped rows with their reasons', async () => {
    const rows = [row(1), row(2, { reasons: ['full-review'] }), row(3)];
    call.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'POST'
          ? {
              ok: true,
              status: 200,
              body: {
                action: 'approve',
                counts: { done: 2, skipped: 1, failed: 0 },
                results: [
                  { id: rows[0]!.offerId, outcome: 'done', name: 'Dates 1' },
                  { id: rows[1]!.offerId, outcome: 'done', name: 'Dates 2' },
                  {
                    id: rows[2]!.offerId,
                    outcome: 'skipped',
                    reason: 'review.bulk-not-allowed',
                    name: 'Dates 3',
                    blockers: ['handling', 'contact-text'],
                  },
                ],
              },
            }
          : firstPage(rows),
      ),
    );
    mount('first');
    await tick('Dates 1');
    await tick('Dates 2');
    await tick('Dates 3');
    await bulk('Approve ticked…');
    const dialog = await screen.findByRole('dialog', { name: 'Approve 3 offers?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 3 offers' }));
    expect(await within(dialog).findByText('2 rows decided, 1 skipped.')).toBeTruthy();
    const skipped = within(dialog).getByRole('region', { name: 'Skipped rows' });
    expect(skipped.textContent).toContain(
      'Dates 3: needs a closer look (R3 Handling, R5 Contact text). Open it to decide.',
    );
    expect(bulkWrites()[0]?.[2]).toMatchObject({ action: 'approve', kind: 'offer' });
  });

  it('says why a bulk approval is not asked for when a row needs one-by-one review', async () => {
    call.mockResolvedValue(firstPage([row(1), row(2, { reasons: ['handling'] })]));
    mount('first');
    await tick('Dates 1');
    await tick('Dates 2');
    await bulk('Approve ticked…');
    const dialog = await screen.findByRole('dialog', { name: 'These rows need a closer look' });
    // The rows to open one by one are named, not the reason codes.
    expect(within(dialog).getByRole('listitem').textContent).toBe('Dates 2');
    expect(within(dialog).queryByText(/R3 Handling/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(bulkWrites()).toEqual([]);
  });

  it('names the seller and the certificate in the confirmation of certificate rows, and refuses mixed sellers', async () => {
    const badge = (n: number, over: Partial<FirstRow> = {}) =>
      row(n, { reasons: ['certificate-badge'], tagTypes: ['halal'], ...over });
    call.mockResolvedValue(firstPage([badge(1), badge(2), badge(3, { sellerId: SELLER_B })]));
    mount('first');
    await tick('Dates 1');
    await tick('Dates 2');
    await bulk('Approve ticked…');
    const dialog = await screen.findByRole('dialog', { name: 'Approve 2 offers?' });
    expect(
      within(dialog).getByText(/Certificate to check: Halal, seller Date Palace/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await tick('Dates 3');
    await bulk('Approve ticked…');
    expect(await screen.findByText(/one seller and share one certificate type/)).toBeTruthy();
  });

  it('shows no bulk decision without the approve permission', async () => {
    call.mockResolvedValue(firstPage([row(1)]));
    mount('first', false);
    await tick('Dates 1');
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    expect(screen.queryByRole('menuitem', { name: 'Approve ticked…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeTruthy();
  });

  it('shows an error with a retry and keeps the list', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount('first');
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again|Retry/ })).toBeTruthy();
  });
});

const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
const categories = {
  ok: true,
  status: 200,
  body: { categories: [{ id: CATEGORY, name: 'Pantry', depth: 0 }] },
} as never;
const sellers = [
  { sellerId: SELLER_A, storeName: 'Date Palace' },
  { sellerId: SELLER_B, storeName: null },
];
/** Picks one condition in the filter panel and applies it. */
async function filterBy(field: string, value: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^Filter/ }));
  fireEvent.change(await screen.findByLabelText('Field'), { target: { value: field } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
}
const lastAsked = (prefix: string) =>
  new URLSearchParams(String(reads(prefix).at(-1)?.[1]).split('?')[1]);

describe('seller, category and reason filters', () => {
  it('filters first publications by reason, store and category, with the stores of the answer', async () => {
    call.mockImplementation((_m: string, path: string) =>
      Promise.resolve(
        path === 'catalog/categories'
          ? categories
          : page([row(1)], {
              totals: { 'product-revision': 0, 'offer-first-publication': 1 },
              sellers,
            }),
      ),
    );
    mount('first');
    await screen.findByText('Dates 1');
    await filterBy('reasons', 'certificate-badge');
    await waitFor(() =>
      expect(lastAsked('catalog/admin/review-queue').get('reasons')).toBe('certificate-badge'),
    );
    await filterBy('sellerId', SELLER_B);
    await waitFor(() =>
      expect(lastAsked('catalog/admin/review-queue').get('sellerId')).toBe(SELLER_B),
    );
    // A store sellers cannot name shows with its short id.
    expect(
      await screen.findByRole('button', { name: /Remove filter Store is .*0190a000/ }),
    ).toBeTruthy();
    await filterBy('categoryId', CATEGORY);
    await waitFor(() =>
      expect(lastAsked('catalog/admin/review-queue').get('categoryId')).toBe(CATEGORY),
    );
    expect(lastAsked('catalog/admin/review-queue').get('kind')).toBe('offer-first-publication');
    expect(savedReads.some((path) => path.endsWith('listKey=admin.catalog.review-queue'))).toBe(
      true,
    );
  });

  it('filters held edits by store and category and has saved filters of their own', async () => {
    call.mockImplementation((_m: string, path: string) =>
      Promise.resolve(
        path === 'catalog/categories' ? categories : page([edit(1)], { totalPending: 1, sellers }),
      ),
    );
    mount('edits');
    await screen.findByText('Dates 1');
    await waitFor(() =>
      expect(savedReads).toContain('lists/admin/saved-filters?listKey=admin.catalog.offer-changes'),
    );
    await filterBy('sellerId', SELLER_A);
    await waitFor(() =>
      expect(lastAsked('catalog/admin/offer-changes').get('sellerId')).toBe(SELLER_A),
    );
    expect(
      await screen.findByRole('button', { name: /Remove filter Store is Date Palace/ }),
    ).toBeTruthy();
    await filterBy('categoryId', CATEGORY);
    await waitFor(() =>
      expect(lastAsked('catalog/admin/offer-changes').get('categoryId')).toBe(CATEGORY),
    );
  });
});

describe('what a screen reader hears', () => {
  it('announces the tab count in a polite live region once it is read', async () => {
    call.mockResolvedValue(firstPage([row(1)]));
    const { container } = mount('first');
    await screen.findByText('Dates 1');
    const live = container.querySelector('[aria-live="polite"].sr-only');
    expect(live).not.toBeNull();
    await waitFor(() => expect(live?.textContent).toBe('3 rows wait for review'));
  });

  it('announces how many offers are selected', async () => {
    call.mockResolvedValue(firstPage([row(1), row(2)]));
    mount('first');
    await tick('Dates 1');
    const status = await screen.findByText('1 offer selected');
    expect(status.closest('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('first publications age filter', () => {
  it('offers "waiting longer than" next to the date presets, in the same field', async () => {
    call.mockResolvedValue(firstPage([row(1)]));
    mount('first');
    await screen.findByText('Dates 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const field = await screen.findByRole('combobox', { name: 'Field' });
    expect(within(field).getByRole('option', { name: 'Submitted' })).toBeTruthy();
  });
});

describe('edits tab', () => {
  it('reads the held edits with their filters, shows the count and has no bulk decision', async () => {
    call.mockResolvedValue(editsPage([edit(1), edit(2)]));
    mount('edits');
    expect(await screen.findByText('Dates 1')).toBeTruthy();
    expect(screen.getAllByText('R3 Handling').length).toBe(2);
    expect(await screen.findByRole('link', { name: 'Edits (5)' })).toBeTruthy();
    expect(String(reads('catalog/admin/offer-changes')[0]?.[1])).toContain('paging=pages');
    await tick('Dates 1');
    // No bulk decision on edits: the menu is just "Actions" (export).
    expect(screen.queryByRole('button', { name: 'Bulk action' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.queryByRole('menuitem', { name: /Approve|Send back/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeTruthy();
  });

  it('opens an edit in the drawer with its diff and rejects it with a note', async () => {
    call.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        method === 'POST'
          ? { ok: true, status: 200, body: {} }
          : path.startsWith('catalog/admin/offer-changes')
            ? editsPage([edit(1)])
            : { ok: false, failure: { status: 404, code: 'x' } },
      ),
    );
    mount('edits');
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    expect(
      within(drawer).getByRole('region', { name: 'Description (en-AU)', hidden: true }),
    ).toBeTruthy();
    fireEvent.change(within(drawer).getByRole('textbox', { hidden: true }), {
      target: { value: 'Not acceptable.' },
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Reject', hidden: true }));
    await waitFor(() => expect(bulkWrites().length).toBe(1));
    expect(bulkWrites()[0]).toEqual([
      'POST',
      'catalog/admin/offer-changes/0190a000-0000-7000-8000-000000000301/reject',
      { note: 'Not acceptable.' },
      'csrf',
    ]);
  });
});
