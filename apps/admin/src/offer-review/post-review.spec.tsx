// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const { inner } = vi.hoisted(() => ({
  inner: vi.fn<(method: string, path: string, ...rest: unknown[]) => Promise<unknown>>(),
}));
// Saved filters and categories are served apart from the list's own calls the tests count.
vi.mock('../api/client.ts', () => ({
  callApi: (method: string, path: string, ...rest: unknown[]) => {
    if (path.startsWith('lists/admin/saved-filters')) {
      return Promise.resolve({ ok: true, status: 200, body: { items: [], canShare: false } });
    }
    if (path === 'catalog/categories') {
      return Promise.resolve({ ok: true, status: 200, body: { categories: [] } });
    }
    return inner(method, path, ...rest);
  },
}));

import { OfferReviewQueue } from './queue.tsx';
import { reasonChipKeys, type PostReviewRow } from './post-review-types.ts';

const call = inner;
const SELLER = '0190a000-0000-7000-8000-0000000000f1';
const ALL_KEYS = ['catalog.product.view', 'catalog.product.approve', 'catalog.product.delete'];
const rowId = (n: number) => `0190a000-0000-7000-8000-00000000040${n}`;
const row = (n: number, over: Partial<PostReviewRow> = {}): PostReviewRow => ({
  id: rowId(n),
  version: n,
  status: 'open',
  reasons: ['sample'],
  samplePercent: 5,
  sampleDoubled: false,
  openedAt: '2026-11-24T22:00:00.000Z',
  decidedAt: null,
  decision: null,
  offer: {
    id: `0190a000-0000-7000-8000-00000000010${n}`,
    status: 'published',
    listed: true,
    sellerSku: `SKU-${n}`,
  },
  product: { id: `0190a000-0000-7000-8000-00000000020${n}`, name: `Dates ${n}` },
  sellerId: SELLER,
  storeName: 'Date Palace',
  actions: { approve: true, takeDown: true },
  ...over,
});
const page = (items: PostReviewRow[], extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    status: 200,
    body: {
      items,
      total: items.length,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: false,
      totalOpen: 7,
      sellers: [{ sellerId: SELLER, storeName: 'Date Palace' }],
      sellersCapped: false,
      ...extra,
    },
  }) as never;

function mount(keys: readonly string[] = ALL_KEYS) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
      <OfferReviewQueue
        tab="after"
        paging="pages"
        accountId="0190a000-0000-7000-8000-000000000099"
        marketId="AU"
        csrfToken="csrf"
        zone="Australia/Brisbane"
        permissionKeys={keys}
        canDecide={keys.includes('catalog.product.approve')}
      />
    </NextIntlClientProvider>,
  );
}
const reads = () =>
  call.mock.calls.filter(
    ([m, path]) => m === 'GET' && path.startsWith('catalog/admin/offer-post-reviews?'),
  );
const writes = () => call.mock.calls.filter(([m]) => m === 'POST');
async function openDrawer(): Promise<HTMLElement> {
  return waitFor(() => {
    const open = [...document.querySelectorAll<HTMLElement>('dialog[open]')];
    if (open.length === 0) throw new Error('no open dialog');
    return open[0]!;
  });
}
async function tick(name: string) {
  const tr = (await screen.findByText(name)).closest('tr') as HTMLElement;
  fireEvent.click(within(tr).getByRole('checkbox'));
}
/** Serves the list and answers each POST by its path. */
function serve(rows: PostReviewRow[], posts: Record<string, unknown> = {}) {
  call.mockImplementation((method: string, path: string) => {
    if (method === 'POST') {
      const suffix = Object.keys(posts).find((key) => path.endsWith(key));
      return Promise.resolve(
        suffix === undefined ? { ok: true, status: 200, body: {} } : posts[suffix],
      );
    }
    if (path.startsWith('catalog/admin/offer-post-reviews?')) return Promise.resolve(page(rows));
    if (path.startsWith('catalog/admin/offer-post-reviews/')) {
      const id = path.split('/').pop();
      const found = rows.find((each) => each.id === id);
      return Promise.resolve(
        found === undefined
          ? { ok: false, failure: { status: 404, code: 'post-review.not-found' } }
          : { ok: true, status: 200, body: { ...found, note: 'Checked the label photo.' } },
      );
    }
    return Promise.resolve({ ok: false, failure: { status: 404, code: 'x' } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('reason chips', () => {
  it('shows "Sample ×2" for a doubled draw and keeps an unknown code as it came', () => {
    expect(
      reasonChipKeys({
        reasons: ['sample', 'price-no-reference', 'new-code'],
        sampleDoubled: true,
      }),
    ).toEqual([
      { code: 'sample', key: 'sample-doubled' },
      { code: 'price-no-reference', key: 'price-no-reference' },
      { code: 'new-code', key: null },
    ]);
  });
});

describe('After publication tab', () => {
  it('reads the open view with every reason chip, the tab count and the three tabs', async () => {
    serve([
      row(1, { reasons: ['sample'], sampleDoubled: true, samplePercent: 10 }),
      row(2, {
        reasons: ['price-no-reference', 'price-reference-unavailable', 'price-recheck-outside'],
        samplePercent: null,
      }),
      row(3),
    ]);
    mount();
    expect(await screen.findByText('Dates 1')).toBeTruthy();
    expect(screen.getByText('Sample ×2')).toBeTruthy();
    expect(screen.getByText('Sample')).toBeTruthy();
    expect(screen.getByText('Price: no reference')).toBeTruthy();
    expect(screen.getByText('Price: reference unavailable')).toBeTruthy();
    expect(screen.getByText('Price: outside band on re-check')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'After publication (7)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edits' }).getAttribute('href')).toBe(
      '/offer-reviews?tab=edits',
    );
    const asked = new URLSearchParams(String(reads()[0]?.[1]).split('?')[1]);
    expect(asked.get('status')).toBe('open');
    expect(asked.get('sort')).toBe('opened');
    expect(asked.get('paging')).toBe('pages');
    // No price, median or note anywhere on the list.
    expect(document.body.textContent).not.toMatch(/median|\$/i);
  });

  it('shows the empty state when nothing is open', async () => {
    serve([]);
    mount();
    expect(await screen.findByText('Nothing to check after publication.')).toBeTruthy();
  });

  it('opens the drawer and approves with the row version, then opens the next row', async () => {
    serve([row(1), row(2)]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    expect(
      within(drawer).getByText('The offer stays on sale while this check is open.'),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole('link', { name: 'Date Palace', hidden: true }).getAttribute('href'),
    ).toBe(`/sellers/${SELLER}`);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve', hidden: true }));
    await waitFor(() => expect(within(drawer).getByText('SKU-2')).toBeTruthy());
    expect(writes()[0]?.[1]).toBe(`catalog/admin/offer-post-reviews/${rowId(1)}/approve`);
    expect(writes()[0]?.[2]).toEqual({ version: 1 });
  });

  it('shows a decided row with its decision and the note read from its own route', async () => {
    serve([
      row(1, {
        status: 'taken-down',
        decidedAt: '2026-11-25T01:00:00.000Z',
        decision: { reasonCode: 'description-claim', misconduct: true },
        actions: { approve: false, takeDown: false },
        offer: { id: 'o', status: 'changes-needed', listed: false, sellerSku: 'SKU-1' },
      }),
    ]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Checked the label photo.')).toBeTruthy();
    expect(within(drawer).getByText('Description makes a claim')).toBeTruthy();
    expect(within(drawer).getByText('Yes, the seller lost Trusted')).toBeTruthy();
    expect(within(drawer).getByText('Changes needed, not listed')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Approve', hidden: true })).toBeNull();
  });

  it('shows no Take down without the delete key, and no decision without the approve key', async () => {
    serve([row(1)]);
    mount(['catalog.product.view', 'catalog.product.approve']);
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    let drawer = await openDrawer();
    expect(within(drawer).getByRole('button', { name: 'Approve', hidden: true })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Take down…', hidden: true })).toBeNull();
    cleanup();
    serve([row(1)]);
    mount(['catalog.product.view']);
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    drawer = await openDrawer();
    expect(within(drawer).queryByRole('button', { name: 'Approve', hidden: true })).toBeNull();
    expect(within(drawer).getByText(/You can view this check but not decide/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bulk action' })).toBeTruthy();
  });
});

describe('take-down dialog', () => {
  async function openTakeDown(rows: PostReviewRow[], posts: Record<string, unknown> = {}) {
    serve(rows, posts);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Take down…', hidden: true }));
    return screen.findByRole('dialog', { name: 'Take this offer down?', hidden: true });
  }

  it('needs a reason and a note, explains carts and orders, and sends the closed body', async () => {
    const dialog = await openTakeDown([row(1), row(2)]);
    expect(
      within(dialog).getByText(/Removed from open carts; orders already placed still ship/),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Take down', hidden: true });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('combobox', { hidden: true }), {
      target: { value: 'description-claim' },
    });
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'This is misconduct (seller loses Trusted)',
        hidden: true,
      }),
    );
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { hidden: true }), {
      target: { value: '  Claims halal without a certificate.  ' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]?.[1]).toBe(`catalog/admin/offer-post-reviews/${rowId(1)}/take-down`);
    expect(writes()[0]?.[2]).toEqual({
      version: 1,
      reasonCode: 'description-claim',
      misconduct: true,
      note: 'Claims halal without a certificate.',
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Take this offer down?', hidden: true }),
      ).toBeNull(),
    );
  });

  it.each([
    ['offer.not-live', 409, /no longer on sale, so it cannot be taken down/],
    ['post-review.own-submission', 403, /your own account submitted/],
    ['conflict.stale', 409, /Changed since you opened it/],
    ['access.unavailable', 503, /could not be sent. Nothing changed/],
  ])('tells a refusal %s and stays open', async (code, status, text) => {
    const dialog = await openTakeDown([row(1)], {
      '/take-down': { ok: false, failure: { status, code } },
    });
    fireEvent.change(within(dialog).getByRole('combobox', { hidden: true }), {
      target: { value: 'other' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { hidden: true }), {
      target: { value: 'Wrong product.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Take down', hidden: true }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(
      screen.getByRole('dialog', { name: 'Take this offer down?', hidden: true }),
    ).toBeTruthy();
  });
});

describe('bulk approve', () => {
  it('sends only ids and versions and names the skipped rows with why', async () => {
    const rows = [row(1), row(2), row(3)];
    serve(rows, {
      '/bulk-approve': {
        ok: true,
        status: 200,
        body: {
          counts: { done: 1, skipped: 2, failed: 0 },
          results: [
            { id: rowId(1), outcome: 'done', name: 'Dates 1' },
            { id: rowId(2), outcome: 'skipped', reason: 'post-review.not-open', name: 'Dates 2' },
            { id: rowId(3), outcome: 'skipped', reason: 'post-review.own-submission', name: null },
          ],
        },
      },
    });
    mount();
    await tick('Dates 1');
    await tick('Dates 2');
    await tick('Dates 3');
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 3 offers?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 3 offers' }));
    expect(await within(dialog).findByText('1 row decided, 2 skipped.')).toBeTruthy();
    const skipped = within(dialog).getByRole('region', { name: 'Skipped rows' });
    expect(skipped.textContent).toContain('Dates 2: already decided.');
    // A row the answer names without a product name keeps the name the list showed.
    expect(skipped.textContent).toContain('Dates 3: your own account submitted this offer.');
    expect(writes()[0]?.[1]).toBe('catalog/admin/offer-post-reviews/bulk-approve');
    expect(writes()[0]?.[2]).toEqual({
      items: [
        { id: rowId(1), version: 1 },
        { id: rowId(2), version: 2 },
        { id: rowId(3), version: 3 },
      ],
    });
  });
});
