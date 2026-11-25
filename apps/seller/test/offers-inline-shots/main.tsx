import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { OffersList } from '../../src/catalog/offers-list.tsx';
import type { OfferListPage, OfferListRow } from '../../src/catalog/types.ts';

// A stand-in for the seller Offer list with its price and stock cells (Offer page PR 8), from
// mocked API answers.

const id = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const W1 = id(0xc1);
const W2 = id(0xc2);
const offers = [
  {
    n: 1,
    name: 'Beef rump steak',
    code: 'P00000371',
    sizes: [
      ['500 g', '1790', 25],
      ['250 g', '950', 40],
    ],
    status: 'published',
  },
  {
    n: 2,
    name: 'Beef mince',
    code: 'P00000412',
    sizes: [['500 g', '1790', 3]],
    status: 'published',
  },
  {
    n: 3,
    name: 'Pork-free beef sausages',
    code: 'P00000415',
    sizes: [['1 kg', '2100', 0]],
    status: 'published',
    two: true,
  },
  { n: 4, name: 'Lamb shoulder', code: 'P00000420', sizes: [['1 kg', null, 0]], status: 'draft' },
] as const;
const offerId = (n: number) => id(n);
const variantId = (n: number, i: number) => id(0x100 + n * 16 + i);

const row = (o: (typeof offers)[number]): OfferListRow => ({
  offerId: offerId(o.n),
  productId: id(0xb0 + o.n),
  product: {
    productCode: o.code,
    typeCode: 'meat',
    name: o.name,
    scope: 'PLATFORM',
    primaryImageId: null,
  },
  sellerSku: o.code,
  conditionCode: 'new',
  description: {},
  status: o.status,
  listed: o.status === 'published',
  offSaleCauses: [],
  handling: 'FRESH',
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-11-20T01:00:00Z',
  version: 1,
  actions: ['open', 'edit'],
});
const page: OfferListPage = {
  items: offers.map(row),
  total: 4,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: { draft: 1, pendingFirstPublish: 0, changesNeeded: 0, published: 3, all: 4 },
};

const answer = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  );
globalThis.fetch = (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://x');
  const path = url.pathname.replace(/^\/api\//, '');
  if (path === 'pricing/seller/offer-prices') {
    return answer({
      currency: 'AUD',
      offers: offers.map((o) => ({
        offerId: offerId(o.n),
        variants: o.sizes.map(([, amount], i) => ({
          variantId: variantId(o.n, i),
          seriesVersion: amount === null ? null : 3,
          currency: 'AUD',
          inForce: amount === null ? null : { amount, effectiveFrom: '2026-11-01T00:00:00Z' },
          held: null,
          special: null,
          heldSpecial: null,
          retired: false,
        })),
      })),
    });
  }
  if (path === 'inventory/seller/offer-stock') {
    return answer({
      offers: offers.map((o) => ({
        offerId: offerId(o.n),
        variants: o.sizes.map(([, , onHand], i) => ({
          variantId: variantId(o.n, i),
          sources: [
            {
              variantId: variantId(o.n, i),
              sourceId: W1,
              onHand,
              held: 0,
              version: 2,
              retired: false,
            },
            {
              variantId: variantId(o.n, i),
              sourceId: W2,
              onHand: 'two' in o ? 6 : 0,
              held: 0,
              version: 1,
              retired: false,
            },
          ].slice(0, 'two' in o ? 2 : 1),
        })),
      })),
    });
  }
  if (path === 'inventory/seller/sources') {
    return answer({
      version: 1,
      max: 10,
      sources: [
        {
          id: W1,
          name: 'Warehouse',
          isDefault: true,
          position: 0,
          address: null,
          timeZone: null,
          createdAt: '2026-10-01T00:00:00Z',
        },
        {
          id: W2,
          name: 'Shop',
          isDefault: false,
          position: 1,
          address: null,
          timeZone: null,
          createdAt: '2026-10-01T00:00:00Z',
        },
      ],
    });
  }
  const units = /^catalog\/seller\/offers\/([^/]+)\/sell-units$/.exec(path);
  if (units !== null) {
    const o = offers.find((item) => offerId(item.n) === units[1])!;
    return answer({
      productScope: 'PLATFORM',
      sellerSku: o.code,
      units: o.sizes.map(([label], i) => ({
        variantId: variantId(o.n, i),
        variantNo: i + 1,
        variantCode: `v${i}`,
        state: 'published',
        label,
        selling: true,
        variantSku: null,
        displaySku: `${o.code}-${i + 1}`,
      })),
    });
  }
  if (path.endsWith('/receive-estimates')) {
    // The API stand-in: 15% of the price, rounded half up.
    const lines = (url.searchParams.get('lines') ?? '').split(',').map((pair) => {
      const [variant, minor] = pair.split(':') as [string, string];
      const commission = (BigInt(minor) * 15n + 50n) / 100n;
      return {
        variantId: variant,
        priceMinor: minor,
        commissionMinor: commission.toString(),
        youReceiveMinor: (BigInt(minor) - commission).toString(),
      };
    });
    return answer({ offerId: 'o', currency: 'AUD', taxInclusive: true, lines });
  }
  if (path === 'catalog/seller/offers') return answer(page);
  return Promise.resolve(new Response('{"code":"access.unavailable"}', { status: 503 }));
};

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <div className="mx-auto flex max-w-[1200px] flex-col bg-page p-4 text-fg sm:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Offers</h1>
      <OffersList
        initial={page}
        paging="pages"
        accountId={id(0xf1)}
        marketId="AU"
        csrfToken="csrf"
        permissionKeys={[
          'catalog.offer.view',
          'catalog.offer.edit',
          'pricing.price.view',
          'pricing.price.edit',
          'inventory.stock.view',
          'inventory.stock.edit',
          'commission-payouts.earnings.view',
        ]}
        timeZone="Australia/Brisbane"
      />
    </div>
  </NextIntlClientProvider>,
);
