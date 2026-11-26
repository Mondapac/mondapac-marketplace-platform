import { Card } from '@mondapac/ui';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { FieldList } from '../../src/catalog/field-list.tsx';
import { OfferHeader } from '../../src/catalog/offer-header.tsx';
import type { OfferView } from '../../src/catalog/types.ts';
import { VariantsTable } from '../../src/catalog/variants-table.tsx';
import type { TableRow } from '../../src/catalog/variants-table-logic.ts';

// A stand-in for the one-page offer (Offer page PR 3 and 4): the header and "Your offer" as the server
// page draws them, then the sizes table with mocked data.

const t = createTranslator({ locale: 'en-AU', messages });

// "You receive (est.)" (Offer page PR 4): the API stand-in, 15% of a GST-free price, rounded half
// up like the ledger.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  // The private Cost (Offer page PR 7-UI): read on "Show costs". Fake amounts; no write is mocked.
  if (url.endsWith('/costs')) {
    const body = {
      offerId: 'o1',
      currency: 'AUD',
      variants: [
        { variantId: 'v1', seriesVersion: null, cost: null },
        { variantId: 'v2', seriesVersion: 3, cost: { amount: '900', currency: 'AUD' } },
        { variantId: 'v3', seriesVersion: null, cost: null },
      ],
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  }
  // "Typical price" (Offer page PR 9-UI): 500 g and 250 g have a range, 1 kg has none.
  if (url.endsWith('/typical-prices')) {
    const body = {
      offerId: 'o1',
      variants: [
        { variantId: 'v1', range: { lowMinor: '890', highMinor: '2700' } },
        { variantId: 'v2', range: { lowMinor: '1200', highMinor: '1900' } },
        { variantId: 'v3', range: null },
      ],
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
  }
  if (!url.includes('/receive-estimates')) return realFetch(input, init);
  const lines = decodeURIComponent(url.split('lines=')[1] ?? '')
    .split(',')
    .map((pair) => {
      const [variantId, minor] = pair.split(':') as [string, string];
      const commission = (BigInt(minor) * 15n + 50n) / 100n;
      return {
        variantId,
        priceMinor: minor,
        commissionMinor: commission.toString(),
        youReceiveMinor: (BigInt(minor) - commission).toString(),
      };
    });
  const body = { offerId: 'o1', currency: 'AUD', taxInclusive: true, lines };
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  );
};
const offer: OfferView = {
  offerId: '0190a000-0000-7000-8000-000000000001',
  productId: 'p1',
  product: {
    productCode: 'P00000412',
    typeCode: 'meat',
    name: 'Beef rump steak',
    scope: 'PLATFORM',
    primaryImageId: null,
  },
  sellerSku: 'KED-021',
  conditionCode: 'new',
  description: { 'en-AU': 'Aged 28 days, cut to order.' },
  status: 'draft',
  listed: false,
  offSaleCauses: [],
  handling: 'SEALED_ORIGINAL',
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-11-25T01:00:00Z',
  version: 2,
};
const price = (id: string, amount: string | null, over = {}) => ({
  variantId: id,
  seriesVersion: amount === null ? null : 2,
  currency: 'AUD',
  inForce: amount === null ? null : { amount, effectiveFrom: '2026-11-20T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
  ...over,
});
const unit = (n: number, label: string) => ({
  variantId: `v${n}`,
  variantNo: n,
  variantCode: `KED-021-0${n}`,
  state: 'published' as const,
  label,
  selling: true,
  variantSku: null,
  displaySku: `KED-021-${n}`,
});
const rows: TableRow[] = [
  { n: 1, label: '250 g', amount: '950', onHand: 40, held: 0, over: {} },
  {
    n: 2,
    label: '500 g',
    amount: '1790',
    onHand: 25,
    held: 3,
    over: {
      special: {
        amount: '1590',
        startsAt: '2026-11-20T00:00:00Z',
        endsAt: '2026-11-30T06:00:00Z',
        state: 'running',
      },
    },
  },
  { n: 3, label: '1 kg', amount: null, onHand: 0, held: 0, over: {} },
].map((r) => ({
  variantId: `v${r.n}`,
  label: r.label,
  price: price(`v${r.n}`, r.amount, r.over),
  stock: {
    s1: {
      variantId: `v${r.n}`,
      sourceId: 's1',
      onHand: r.onHand,
      held: r.held,
      version: 2,
      retired: false,
    },
  },
  unit: unit(r.n, r.label),
}));

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <div className="mx-auto flex max-w-[1200px] flex-col gap-6 bg-page p-4 text-fg sm:p-6">
      <OfferHeader offer={offer} canEdit t={t as (key: string) => string} />
      <Card title={t('catalog.offer.your-offer')}>
        <FieldList
          rows={[
            { label: t('catalog.offers.col.sku'), value: offer.sellerSku },
            { label: t('catalog.offer.condition'), value: 'New' },
            { label: t('catalog.offer.handling'), value: 'Sealed original' },
          ]}
        />
        <div className="mt-4 flex flex-col gap-1 border-t border-line pt-4">
          <h3 className="text-sm font-medium">{t('catalog.offer.description')}</h3>
          <p>
            <span className="me-2 text-sm text-fg-muted">en-AU</span>Aged 28 days, cut to order.
          </p>
        </div>
      </Card>
      <VariantsTable
        offerId={offer.offerId}
        rows={rows}
        sources={[
          {
            id: 's1',
            name: 'Warehouse',
            isDefault: true,
            position: 0,
            address: null,
            timeZone: null,
            createdAt: '2026-10-01T00:00:00Z',
          },
        ]}
        currency="AUD"
        canEditPrice
        canEditStock
        canViewTypical
        units={{ canEdit: true, productScope: 'PLATFORM', sellerSku: 'KED-021' }}
        csrfToken="csrf"
        canEstimate
        canViewCost
      />
    </div>
  </NextIntlClientProvider>,
);
