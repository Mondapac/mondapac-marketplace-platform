import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductsList } from '../../src/catalog/products-list.tsx';
import { ProductEdit } from '../../src/catalog/product-form/edit-form.tsx';
import type { TopicChoice, TopicRef } from '../../src/catalog/product-form/types.ts';
import type { ProductView } from '../../src/catalog/product-form/types.ts';
import { read } from '../../src/catalog/version-review/fixtures.ts';
import { VersionReview } from '../../src/catalog/version-review/version-review.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const names = (en: string) => ({ en });
const ref = (n: number, name: string, status: TopicRef['status'] = 'active'): TopicRef => ({
  id: id(100 + n),
  slug: `tag-${n}`,
  status,
  name,
  names: names(name),
});
const choice = (n: number, name: string, group: TopicChoice['group']): TopicChoice => ({
  id: id(100 + n),
  slug: `tag-${n}`,
  group,
  status: 'active',
  names: names(name),
});
const CHOICES: TopicChoice[] = [
  choice(1, 'Eid', 'occasion'),
  choice(2, 'Barbecue', 'cuisine'),
  choice(3, 'Picnic', 'use'),
  choice(4, 'Ramadan gifts', 'occasion'),
  choice(5, 'Lunch box', 'use'),
  choice(6, 'Middle Eastern', 'cuisine'),
  choice(7, 'Breakfast', 'use'),
  choice(8, 'Weekend feast', 'occasion'),
];
const PRODUCT = id(1);
const product: ProductView = {
  productId: PRODUCT,
  productCode: 'MP-004127',
  typeCode: 'grocery',
  familyCode: 'pantry',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  offers: { sellerCount: 0, offerCount: 0 },
  variants: [{ variantId: id(21), state: 'proposed' }],
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst-free-food', 'gst'],
    fields: [],
    categories: [
      { categoryId: id(10), parentId: null, names: names('Pantry') },
      { categoryId: id(11), parentId: id(10), names: names('Rice') },
    ],
  },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: {
    content: {
      texts: { en: { name: 'Sella basmati rice', description: 'Extra-long grain rice.' } },
      categoryIds: [id(11)],
      taxCategoryCode: 'gst-free-food',
      topicIds: [id(101), id(102), id(150), id(199)],
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
  topicRefs: [ref(1, 'Eid'), ref(2, 'Barbecue'), ref(50, 'Ramadan special offers', 'archived')],
};

const scenario = new URLSearchParams(location.search).get('s') ?? 'form';
const row = (
  n: number,
  name: string,
  topics: { n: number; name: string; archived?: boolean }[],
) => ({
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
  status: 'published' as const,
  offerCount: 3,
  topics: topics.map((t) => ({
    id: id(100 + t.n),
    slug: `tag-${t.n}`,
    status: t.archived ? ('archived' as const) : ('active' as const),
    name: t.name,
  })),
  updatedAt: '2026-10-29T01:00:00.000Z',
  createdAt: '2026-10-01T01:00:00.000Z',
});
const listPage = {
  items: [
    row(1, 'Sella basmati rice', [
      { n: 1, name: 'Eid' },
      { n: 2, name: 'Barbecue' },
      { n: 3, name: 'Picnic' },
    ]),
    row(2, 'Lamb cutlets 500 g', [{ n: 50, name: 'Ramadan special offers', archived: true }]),
    row(3, 'Dates 1 kg', []),
  ],
  total: 3,
  page: 1,
  pageSize: 25,
  counts: { active: 3, all: 3, inactive: 0 },
};

window.fetch = ((input: string, init?: RequestInit) => {
  const url = new URL(input, 'http://x');
  const path = url.pathname.replace(/^\/api\//, '');
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (path === 'catalog/admin/topics') {
    const term = (url.searchParams.get('search') ?? '').toLowerCase();
    const items = CHOICES.filter((item) => item.names['en']!.toLowerCase().includes(term));
    return json({ items, nextAfterId: null });
  }
  if (path === `catalog/admin/platform-products/${PRODUCT}` && init?.method === 'GET') {
    return json(product);
  }
  if (path.endsWith('/draft') && scenario === 'error') {
    return json(
      {
        statusCode: 422,
        code: 'revision.not-ready',
        details: {
          issues: [
            { path: 'topicIds.2', code: 'archived' },
            { path: 'topicIds.3', code: 'unknown' },
          ],
        },
      },
      422,
    );
  }
  if (path === 'catalog/admin/products') return json(listPage);
  if (path === 'catalog/categories') {
    return json({ categories: [{ id: id(10), name: 'Pantry', depth: 0 }] });
  }
  if (path.startsWith('catalog/admin/saved-filters')) {
    return json({ items: [], canShare: false, limits: { perOwner: 50, shared: 20 } });
  }
  return json({ variantIds: [id(21)], refusedFields: [] });
}) as typeof fetch;

if (scenario === 'column') {
  window.localStorage.setItem('mp:admin:AU:acc-1:products-columns', JSON.stringify(['tags']));
}

const body =
  scenario === 'review' ? (
    <VersionReview
      read={read}
      images={[]}
      categoryNames={{}}
      canDecide
      canTakeDown={false}
      csrfToken="tok"
      nextHref={null}
    />
  ) : scenario === 'column' ? (
    <ProductsList
      accountId="acc-1"
      marketId="AU"
      marketName="Australia"
      timeZone="Australia/Brisbane"
      permissionKeys={['catalog.product.view']}
      csrfToken="tok"
    />
  ) : (
    <ProductEdit
      productId={PRODUCT}
      csrfToken="tok"
      marketName="Australia"
      timeZone="Australia/Brisbane"
      canPause
      canReadTags={scenario !== 'readonly'}
    />
  );
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    <main className="mx-auto max-w-7xl p-4 md:p-6">{body}</main>
  </NextIntlClientProvider>,
);
