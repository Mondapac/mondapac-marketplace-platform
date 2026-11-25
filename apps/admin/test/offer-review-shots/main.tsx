import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { EmergencyStopBanner } from '../../src/offer-review-emergency-stop/emergency-stop-banner.tsx';
import { CategoryFlags } from '../../src/offer-review/category-flags.tsx';
import { OfferReviewQueue } from '../../src/offer-review/queue.tsx';
import { OfferReviewCard } from '../../src/sellers/offer-review-card.tsx';
import { standingOf } from '../../src/offer-review/standing.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'first';

const first = (n: number, name: string, reasons: string[], over: object = {}) => ({
  kind: 'offer-first-publication',
  offerId: id(100 + n),
  version: n,
  sellerId: id(10),
  storeName: 'Date Palace',
  productId: id(200 + n),
  product: { productCode: `P${n}`, typeCode: 'grocery', name },
  sellerSku: `SKU-${n}`,
  conditionCode: 'new',
  description: { 'en-AU': 'Fresh Medjool dates, packed in a sealed 500 g tub. Product of Jordan.' },
  handling: 'SEALED_ORIGINAL',
  reasons,
  tagTypes: reasons.includes('certificate-badge') ? ['halal'] : [],
  submittedAt: `2026-11-2${n}T01:00:00.000Z`,
  actions: ['approve', 'request-changes'],
  ...over,
});
const firstRows = [
  first(1, 'Medjool dates 500 g', ['probation']),
  first(2, 'Lamb shoulder, halal', ['certificate-badge']),
  first(3, 'Tahini 450 g', ['full-review'], { storeName: 'Corner Pantry', sellerId: id(11) }),
  first(4, 'Rose water 250 ml', ['handling', 'contact-text'], { handling: null }),
  first(5, 'Baklava assorted box', ['sensitive-category', 'emergency-stop']),
];
const edit = (n: number, name: string, reasons: string[], over: object = {}) => ({
  changeId: id(300 + n),
  offerId: id(100 + n),
  status: 'pending',
  fields: ['description', 'handling', 'tags'],
  proposedDescription: {
    'en-AU': 'Fresh Medjool dates in a resealable pouch. Product of Jordan, halal certified.',
    ms: 'Kurma Medjool segar.',
  },
  proposedHandling: 'REPACKED',
  proposedTagTypes: ['halal', 'organic'],
  baseOfferVersion: 2,
  submittedAt: `2026-11-2${n}T01:00:00.000Z`,
  decidedAt: null,
  decisionNote: null,
  supersededCause: null,
  reasons,
  sellerId: id(10),
  storeName: 'Date Palace',
  offer: {
    productId: id(200 + n),
    sellerSku: `SKU-${n}`,
    conditionCode: 'new',
    status: 'published',
    version: 3,
  },
  product: { productCode: `P${n}`, typeCode: 'grocery', name },
  live: {
    description: {
      'en-AU': 'Fresh Medjool dates, packed in a sealed 500 g tub. Product of Jordan.',
      ms: 'Kurma Medjool segar.',
    },
    handling: 'SEALED_ORIGINAL',
    tagTypes: ['halal'],
  },
  actions: ['approve', 'request-changes', 'reject'],
  ...over,
});
const editRows = [
  edit(1, 'Medjool dates 500 g', ['handling', 'certificate-badge']),
  edit(2, 'Lamb shoulder, halal', ['contact-text'], { fields: ['description'] }),
  edit(3, 'Tahini 450 g', ['full-review', 'sensitive-category'], { storeName: 'Corner Pantry' }),
];
const paged = (items: unknown[], extra: object = {}) => ({
  items,
  nextAfterId: null,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  ...extra,
});
const standing = {
  status: 'probation',
  source: null,
  trustedSince: null,
  count: 4,
  target: 10,
  targetKind: 'initial',
  consecutiveChangesNeeded: 0,
};
const flags = {
  trustedFromStart: { on: false, changedAt: null },
  fullReview: { on: true, changedAt: '2026-11-20T03:00:00Z' },
  reviewStop: { on: false, changedAt: null },
  version: 4,
};
const categories = {
  items: [
    {
      categoryId: id(500),
      alwaysReview: true,
      reviewStop: false,
      alwaysReviewChangedAt: '2026-11-20T03:00:00Z',
      reviewStopChangedAt: null,
      version: 3,
    },
    {
      categoryId: id(501),
      alwaysReview: false,
      reviewStop: true,
      alwaysReviewChangedAt: null,
      reviewStopChangedAt: '2026-11-24T05:00:00Z',
      version: 1,
    },
  ],
};
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown = { code: 'not-found' };
  let status = 200;
  if (path === 'catalog/admin/review-queue') {
    body = paged(firstRows, {
      totals: { 'product-revision': 4, 'offer-first-publication': firstRows.length },
    });
  } else if (path === 'catalog/admin/offer-changes') {
    body = paged(editRows, { totalPending: editRows.length });
  } else if (path === 'lists/admin/saved-filters') {
    body = { items: [], canShare: false };
  } else if (path.endsWith('/review-standing')) body = standing;
  else if (path.startsWith('sellers/admin/') && path.endsWith('/offer-review')) body = flags;
  else if (path === 'catalog/admin/offer-review/stops') {
    body = { marketStop: true, stoppedSellers: 2, stoppedCategories: 1, active: true };
  } else if (path === 'settings/admin/offer-review/emergency-stop') {
    body = { on: true, version: 2, changedAt: '2026-11-25T01:30:00Z', changedBy: 'Leila Admin' };
  } else status = 404;
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}) as typeof fetch;

const where = {
  paging: 'pages',
  accountId: id(99),
  marketId: 'AU',
  csrfToken: 'tok',
  zone: 'Australia/Brisbane',
} as const;
const keys = ['catalog.product.view', 'catalog.product.approve', 'sellers.seller.view'];
const title = <h1 className="mb-4 text-2xl font-semibold">Offer reviews</h1>;
const content =
  view === 'seller' ? (
    <div className="max-w-3xl">
      <OfferReviewCard
        sellerId={id(10)}
        csrfToken="tok"
        standing={standingOf(standing)}
        initial={{
          trusted: { on: false, changedAt: null },
          'full-review': { on: true, changedAt: '2026-11-20T03:00:00Z' },
          stop: { on: false, changedAt: null },
          version: 4,
        }}
        can={{ trusted: true, 'full-review': true, stop: false }}
        zone="Australia/Brisbane"
      />
    </div>
  ) : view === 'categories' ? (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Offer review categories</h1>
      <CategoryFlags
        initial={categories.items}
        choices={[
          { id: id(500), label: 'Food > Meat > Lamb' },
          { id: id(501), label: 'Food > Sweets' },
          { id: id(502), label: 'Food > Dates' },
        ]}
        canAlways
        canStop
        csrfToken="tok"
        zone="Australia/Brisbane"
      />
    </>
  ) : view === 'banner' ? (
    <EmergencyStopBanner zone="Australia/Brisbane" canViewStops />
  ) : (
    <>
      {title}
      <OfferReviewQueue
        tab={view === 'edits' ? 'edits' : 'first'}
        {...where}
        permissionKeys={keys}
        canDecide
      />
    </>
  );
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <main className="mx-auto max-w-7xl p-4 md:p-6">{content}</main>
  </NextIntlClientProvider>,
);
