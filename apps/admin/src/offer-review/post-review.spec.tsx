// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const { inner, savedItems } = vi.hoisted(() => ({
  inner: vi.fn<(method: string, path: string, ...rest: unknown[]) => Promise<unknown>>(),
  savedItems: [] as unknown[],
}));
// Saved filters (read from `savedItems`) and categories are served apart from the list's own
// calls; a saved-filter write goes to `inner`, so a test can see it.
vi.mock('../api/client.ts', () => ({
  callApi: (method: string, path: string, ...rest: unknown[]) => {
    if (method === 'GET' && path.startsWith('lists/admin/saved-filters')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { items: savedItems, canShare: true },
      });
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
  savedItems.length = 0;
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
        reasons: [
          'price-no-reference',
          'price-reference-unavailable',
          'price-recheck-outside',
          'preview-contact-text',
        ],
        samplePercent: null,
      }),
      row(3),
    ]);
    mount();
    expect(await screen.findByText('Dates 1')).toBeTruthy();
    expect(screen.getByText('Random check (new Trusted, 2×)')).toBeTruthy();
    expect(screen.getByText('Random check')).toBeTruthy();
    expect(screen.getByText('Price: no comparison yet')).toBeTruthy();
    expect(screen.getByText('Price: comparison unavailable')).toBeTruthy();
    expect(screen.getByText('Price: outside range on re-check')).toBeTruthy();
    expect(screen.getByText('Contact details seen in a recent preview')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Published (7)' })).toBeTruthy();
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
    expect(within(drawer).getByText(/Ask an admin who can approve offers/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeTruthy();
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
      within(dialog).getByText(/removed from open carts; orders already placed still ship/),
    ).toBeTruthy();
    // The dialog names the Offer it takes down: product, SKU and store.
    expect(within(dialog).getByText('Dates 1 · SKU-1 · Date Palace')).toBeTruthy();
    expect(within(dialog).getByText('The seller is told to fix it and submit again.')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 3 offers?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 3 offers' }));
    expect(await within(dialog).findByText('1 row decided, 2 skipped.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '1 approved, 2 skipped' })).toBeTruthy();
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

describe('the super list of After publication', () => {
  const lastAsked = () => new URLSearchParams(String(reads().at(-1)?.[1]).split('?')[1]);

  it('switches the view and asks for its status', async () => {
    serve([row(1)]);
    mount();
    await screen.findByText('Dates 1');
    fireEvent.click(screen.getByRole('button', { name: 'Taken down' }));
    await waitFor(() => expect(lastAsked().get('status')).toBe('taken-down'));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastAsked().get('status')).toBe('all'));
  });

  it('filters by reason with a removable chip, and by age as an opened-before instant', async () => {
    serve([row(1)]);
    mount();
    await screen.findByText('Dates 1');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'reasons' } });
    fireEvent.change(screen.getByLabelText('Value'), {
      target: { value: 'price-recheck-outside' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastAsked().get('reasons')).toBe('price-recheck-outside'));
    expect(lastAsked().get('status')).toBe('open');
    fireEvent.click(await screen.findByRole('button', { name: /Remove filter Reason is/ }));
    await waitFor(() => expect(lastAsked().get('reasons')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'age' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'older-48h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastAsked().get('openedTo')).not.toBeNull());
    const before = Date.parse(lastAsked().get('openedTo') ?? '');
    expect(Date.now() - before).toBeGreaterThanOrEqual(48 * 3_600_000 - 60_000);
    expect(lastAsked().get('openedFrom')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('sorts by Opened or Decided, in either direction', async () => {
    serve([row(1)]);
    mount();
    await screen.findByText('Dates 1');
    expect(lastAsked().get('sort')).toBe('opened');
    expect(lastAsked().get('direction')).toBe('asc');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Decided' }));
    await waitFor(() => {
      expect(lastAsked().get('sort')).toBe('decided');
      expect(lastAsked().get('direction')).toBe('desc');
    });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => expect(lastAsked().get('direction')).toBe('asc'));
  });

  it('opens a saved filter and saves the current one under its own registry list', async () => {
    savedItems.push({
      id: '0190a000-0000-7000-8000-000000000050',
      listKey: 'admin.catalog.offer-post-reviews',
      name: 'Price checks',
      visibility: 'everyone',
      payload: {
        v: 1,
        filters: { status: 'open', reasons: 'price-no-reference' },
        sort: 'opened',
        direction: 'asc',
      },
      ownedByMe: true,
      canManage: true,
    });
    serve([row(1)]);
    call.mockImplementationOnce(() => Promise.resolve(page([row(1)])));
    mount();
    await screen.findByText('Dates 1');
    fireEvent.click(await screen.findByRole('button', { name: 'Price checks' }));
    await waitFor(() => expect(lastAsked().get('reasons')).toBe('price-no-reference'));

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(lastAsked().get('reasons')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'reasons' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(await screen.findByRole('button', { name: /Save filter/ }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Samples' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save filter' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(writes().some(([, path]) => path === 'lists/admin/saved-filters')).toBe(true),
    );
    const sent = writes().find(([, path]) => path === 'lists/admin/saved-filters');
    const body = sent?.[2] as {
      listKey: string;
      name: string;
      payload: { filters: Record<string, string> };
    };
    expect(body.listKey).toBe('admin.catalog.offer-post-reviews');
    expect(body.name).toBe('Samples');
    expect(body.payload.filters['reasons']).toBe('sample');
    expect(sent?.[3]).toBe('csrf');
  });

  it('exports the view and filters as a file, without the sort or the page', async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response('id\n', { status: 200 }));
    }) as typeof fetch;
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => undefined;
    try {
      serve([row(1)]);
      mount();
      await tick('Dates 1');
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Export offers after publication' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
      await waitFor(() => expect(fetched.length).toBe(1));
      const url = new URL(fetched[0]!, 'http://admin.test');
      expect(url.pathname).toBe('/api/catalog/admin/offer-post-reviews/export');
      expect(url.searchParams.get('format')).toBe('csv');
      expect(url.searchParams.get('status')).toBe('open');
      for (const key of ['sort', 'direction', 'page', 'pageSize', 'paging']) {
        expect(url.searchParams.get(key)).toBeNull();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('selects all matching rows, and then offers no bulk approve (it runs on ticked rows only)', async () => {
    call.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        path.startsWith('catalog/admin/offer-post-reviews?')
          ? page([row(1), row(2)], { total: 60, hasNext: true })
          : { ok: false, failure: { status: 404, code: 'x' } },
      ),
    );
    mount();
    await screen.findByText('Dates 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all offers on this page' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all 60 matching' }));
    expect(await screen.findByText('All 60 matching offers are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const approve = await screen.findByRole('menuitem', { name: 'Approve ticked…' });
    expect(
      approve.getAttribute('aria-disabled') === 'true' || (approve as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('says the list could not be loaded on a 503', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount();
    expect(await screen.findByText(/The offers could not be loaded/)).toBeTruthy();
  });

  it('links the drawer to the product page and the seller', async () => {
    serve([row(1)]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review Dates 1' }));
    const drawer = await openDrawer();
    expect(
      within(drawer).getByRole('link', { name: 'Open product', hidden: true }).getAttribute('href'),
    ).toBe(`/catalog/products/${row(1).product.id}/edit`);
  });
});
