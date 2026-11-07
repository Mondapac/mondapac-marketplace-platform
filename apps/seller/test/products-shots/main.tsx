import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductsList } from '../../src/catalog/products-list.tsx';
import type { ProductRow, ProductsPage } from '../../src/catalog/products-list-types.ts';
import type { SavedFilter } from '../../src/catalog/products-saved-types.ts';

const NAMES = [
  ['Extra virgin olive oil 1 L', 'Pantry', 'published', true, false, false],
  ['Halal beef sausages 500 g', 'Meat', 'published', true, true, false],
  ['Medjool dates 1 kg', 'Fruit and nuts', 'matched', true, false, false],
  ['Basmati rice 5 kg', 'Pantry', 'unpublished', false, false, false],
  ['Lamb cutlets 500 g', 'Meat', 'draft', false, false, true],
  ['Tahini 400 g', 'Pantry', 'published', true, false, true],
  ['Chickpeas 400 g (case of 12)', 'Pantry', 'retired', false, false, false],
  ['Rose water 250 ml', 'Pantry', 'published', true, false, false],
] as const;

const rows: ProductRow[] = NAMES.map(([name, category, status, photo, paused, pending], index) => ({
  productId: `0190a000-0000-7000-8000-00000000010${index}`,
  productCode: `P0000${184 + index}`,
  typeCode: 'grocery',
  status,
  name,
  draftName: name,
  primaryImageId: photo ? `0190a000-0000-7000-8000-00000000020${index}` : null,
  categoryId: null,
  categoryName: category,
  offerCount: status === 'draft' ? 0 : 1 + index,
  pausedAt: paused ? '2026-10-30T00:00:00.000Z' : null,
  hasPendingRevision: pending,
  lastChangedAt: `2026-10-${String(29 - index).padStart(2, '0')}T01:00:00.000Z`,
  createdAt: '2026-09-01T01:00:00.000Z',
}));

const params = new URLSearchParams(location.search);
const scenario = params.get('s') ?? 'list';
params.delete('s');
const filtered = scenario === 'filtered';
const empty = scenario === 'empty';
if (filtered) {
  history.replaceState(null, '', '?status=published&paused=true&q=oil');
}
// The Save filter dialog opens on a list that is not a saved one.
if (scenario === 'saved-dialogs') {
  history.replaceState(null, '', '?view=live&q=oil&status=published&sort=name');
}

// The saved filters (F2): two of the member's own and one a colleague shared.
const filterOf = (
  id: string,
  name: string,
  visibility: 'me' | 'everyone',
  mine: boolean,
  payload: SavedFilter['payload'],
): SavedFilter => ({
  id,
  listKey: 'seller.catalog.products',
  name,
  visibility,
  payload,
  ownedByMe: mine,
  canManage: mine,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
});
const savedFilters: SavedFilter[] = [
  filterOf('0190a000-0000-7000-8000-0000000000f1', 'Paused pantry', 'me', true, {
    v: 1,
    view: 'live',
    paused: true,
    sort: 'updated',
    direction: 'desc',
  }),
  filterOf('0190a000-0000-7000-8000-0000000000f2', 'Needs a photo', 'everyone', true, {
    v: 1,
    view: 'drafts',
    sort: 'name',
    direction: 'asc',
  }),
  filterOf('0190a000-0000-7000-8000-0000000000f3', 'Spring range', 'everyone', false, {
    v: 1,
    view: 'all',
    q: 'spring',
    sort: 'created',
    direction: 'desc',
  }),
];

const answer = (): ProductsPage => ({
  items: empty ? [] : filtered ? rows.slice(1, 3) : rows,
  total: empty ? 0 : filtered ? 2 : 143,
  page: 1,
  pageSize: 25,
  counts: empty
    ? { all: 0, drafts: 0, live: 0, inactive: 0, inReview: 0 }
    : { all: 143, drafts: 12, live: 100, inactive: 31, inReview: 4 },
});

// The relay is mocked: the list's own reads answer with the rows above.
const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
const savedAnswer = { items: savedFilters, canShare: true, limits: { perOwner: 50, shared: 20 } };
globalThis.fetch = (input) =>
  String(input).includes('saved-filters')
    ? json(200, savedAnswer)
    : scenario === 'error'
    ? json(503, { code: 'access.unavailable' })
    : scenario === 'loading'
      ? new Promise<Response>(() => undefined)
      : json(200, answer());

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <ProductsList
        accountId="acc-1"
        marketId="AU"
        timeZone="Australia/Brisbane"
        permissionKeys={
          scenario === 'viewonly'
            ? ['catalog.own-product.view']
            : ['catalog.own-product.view', 'catalog.own-product.edit', 'catalog.own-import.run']
        }
        csrfToken="csrf-1"
        categories={[{ id: '0190a000-0000-7000-8000-0000000000c1', name: 'Pantry', depth: 0 }]}
        productTypes={['grocery']}
        paging="pages"
      />
    </main>
  </NextIntlClientProvider>,
);
