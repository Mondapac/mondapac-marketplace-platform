import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductsList } from '../../src/catalog/products-list.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const names = ['Sella basmati rice', 'Lamb cutlets 500 g', 'Dates 1 kg', 'Free-range eggs 12 pack', 'Olive oil 1 L'];
const row = (n: number, name: string) => ({
  productId: id(300 + n),
  productCode: `AU-00018${n}`,
  name,
  primaryImageId: null,
  scope: 'SELLER' as const,
  ownerSellerId: id(900),
  ownerStoreName: 'Cedar Lane',
  categoryId: id(10),
  categoryName: 'Pantry',
  typeCode: 'simple',
  status: n === 3 ? ('paused' as const) : ('published' as const),
  offerCount: 3,
  topics: [],
  updatedAt: '2026-10-29T01:00:00.000Z',
  createdAt: '2026-10-01T01:00:00.000Z',
  actions: n === 3 ? ['open', 'edit', 'resume', 'delete'] : ['open', 'edit', 'pause', 'delete'],
});
const scenario = new URLSearchParams(location.search).get('s') ?? 'list';
const page = {
  items: names.map((name, i) => row(i + 1, name)),
  total: 143,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  counts: { active: 120, all: 143, inactive: 23 },
};
window.fetch = ((input: string, init?: RequestInit) => {
  const url = new URL(input, 'http://x');
  const path = url.pathname.replace(/^\/api\//, '');
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (path === 'catalog/admin/products/bulk') {
    return json({ eligible: 1, confirmOfferCount: 3, affectedOfferCount: 3, counts: { done: 0, skipped: 0, failed: 0 } });
  }
  if (path === 'catalog/admin/products') return json(page);
  if (path === 'catalog/categories') return json({ categories: [{ id: id(10), name: 'Pantry', depth: 0 }] });
  if (path.startsWith('catalog/admin/saved-filters')) {
    return json({
      items: [
        { id: id(1), listKey: 'admin.catalog.products', name: 'Needs review', visibility: 'me', payload: { v: 1, view: 'all', filters: {}, sort: 'updated', direction: 'desc' }, ownedByMe: true, canManage: true, count: 12, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' },
      ],
      canShare: true,
      limits: { perOwner: 50, shared: 20 },
    });
  }
  void init;
  return json({});
}) as typeof fetch;
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    <main className="mx-auto max-w-7xl p-4 md:p-6" data-s={scenario}>
      <ProductsList
        paging="pages"
        accountId="acc-1"
        marketId="AU"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        permissionKeys={['catalog.product.view', 'catalog.platform-product.edit', 'catalog.saved-filter.share']}
        csrfToken="tok"
      />
    </main>
  </NextIntlClientProvider>,
);
