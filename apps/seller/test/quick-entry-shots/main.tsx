import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { OfferEditForm } from '../../src/catalog/offer-edit-form.tsx';
import { QuickEntryTable } from '../../src/catalog/quick-entry.tsx';
import type { QuickGroup } from '../../src/catalog/quick-entry-logic.ts';
import type { OfferView } from '../../src/catalog/types.ts';

// A stand-in for the quick entry table of new drafts and the edit page's Handling (Offer page
// PR 5), from mocked data. `?view=edit` draws the edit form.

// "You receive (est.)": the API stand-in, 15% of a GST-free price, rounded half up.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
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
  const body = { offerId: 'o', currency: 'AUD', taxInclusive: true, lines };
  return Promise.resolve(
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
  );
};

const row = (id: string, label: string) => ({
  variantId: id,
  label,
  price: {
    variantId: id,
    seriesVersion: null,
    currency: 'AUD',
    inForce: null,
    held: null,
    special: null,
    heldSpecial: null,
    retired: false,
  },
  stock: {},
});
const group = (n: number, name: string, code: string, sizes: string[]): QuickGroup => ({
  offerId: `0190a000-0000-7000-8000-00000000000${n}`,
  name,
  productCode: code,
  thumb: null,
  conditionCode: 'new',
  handling: 'SEALED_ORIGINAL',
  rows: sizes.map((label, i) => row(`v${n}${i}`, label)),
});
const groups = [
  group(1, 'Beef brisket', 'P00000371', ['1 kg']),
  group(2, 'Beef mince', 'P00000412', ['250 g', '500 g', '1 kg']),
];
const offer: OfferView = {
  offerId: '0190a000-0000-7000-8000-000000000002',
  productId: 'p1',
  product: {
    productCode: 'P00000412',
    typeCode: 'meat',
    name: 'Beef mince',
    scope: 'PLATFORM',
    primaryImageId: null,
  },
  sellerSku: 'P00000412',
  conditionCode: 'new',
  description: {},
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

const edit = new URL(globalThis.location.href).searchParams.get('view') === 'edit';
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <div className="mx-auto flex max-w-[1200px] flex-col bg-page p-4 text-fg sm:p-6">
      {edit ? (
        <div className="max-w-(--mp-size-form-max)">
          <OfferEditForm
            offer={offer}
            options={{
              productTypes: ['meat'],
              conditions: ['new', 'used'],
              taxCategories: [],
              categories: [],
              locales: { default: 'en-AU', supported: ['en-AU'] },
              sellerCanCreateProduct: true,
            }}
            csrfToken="csrf"
          />
        </div>
      ) : (
        <QuickEntryTable
          groups={groups}
          unreadable={0}
          more={0}
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
          canEstimate
          csrfToken="csrf"
        />
      )}
    </div>
  </NextIntlClientProvider>,
);
