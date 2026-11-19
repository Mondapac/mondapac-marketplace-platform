import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { VariantsTable } from '../../src/catalog/variants-table.tsx';
import type { TableRow } from '../../src/catalog/variants-table-logic.ts';

const params = new URLSearchParams(location.search);
const scenario = params.get('s') ?? 'seller';
const requests = scenario === 'requests' || scenario === 'requests-form';
const platform = scenario === 'platform' || requests;

const stock = (id: string, onHand: number) => ({
  s1: { variantId: id, sourceId: 's1', onHand, held: 0, version: 2, retired: false },
});
const price = (id: string, amount: string) => ({
  variantId: id,
  seriesVersion: 2,
  currency: 'AUD',
  inForce: { amount, effectiveFrom: '2026-10-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
});
const unit = (n: number, label: string | null, over = {}) => ({
  variantId: `v${n}`,
  variantNo: n,
  variantCode: `MP-004127-0${n}`,
  state: 'published' as const,
  label,
  selling: true,
  variantSku: null as string | null,
  displaySku: (over as { variantSku?: string }).variantSku ?? `RICE-${n}`,
  ...over,
});
const last = scenario === 'platform-last';
const sellerSku = platform || last ? 'RICE' : 'MJ';
const names =
  platform || last
    ? ['1 kg', '5 kg', '10 kg', '20 kg']
    : ['Mango · 1 L', 'Mango · 2 L', 'Guava · 1 L', 'Guava · 2 L'];
const skus =
  platform || last ? ['RICE-1KG', null, null, 'RICE-20KG'] : ['MJ-1L', null, null, 'GJ-2L'];
const rows: TableRow[] = [
  { v: 1, amount: '420', n: 36 },
  { v: 2, amount: '750', n: 0 },
  { v: 3, amount: '440', n: 12 },
  { v: 4, amount: '780', n: 8 },
].map((r) => ({
  variantId: `v${r.v}`,
  label: names[r.v - 1]!,
  price: price(`v${r.v}`, r.amount),
  stock: stock(`v${r.v}`, r.n),
  unit: unit(r.v, names[r.v - 1]!, {
    variantSku: skus[r.v - 1],
    // The last scenario has one size on sale; the plain ones have the third off.
    selling: last ? r.v === 2 : r.v !== 3,
  }),
}));

window.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ code: 'offer.sku-taken', statusCode: 409 }), { status: 409 }),
  );

if (scenario === 'requests-form') {
  // The page opens the request form after it mounts.
  setTimeout(() => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === 'Request a size',
    );
    button?.click();
  }, 200);
}

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <div className="mx-auto max-w-[1400px] bg-page p-4 text-fg sm:p-6">
      <VariantsTable
        offerId="0190a000-0000-7000-8000-000000000001"
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
        units={{ canEdit: true, productScope: platform || last ? 'PLATFORM' : 'SELLER', sellerSku }}
        csrfToken="csrf"
        sizeRequests={
          requests
            ? {
                axes: [
                  {
                    code: 'size',
                    name: 'Size',
                    options: ['1 kg', '5 kg', '10 kg', '20 kg', '25 kg'].map((label) => ({
                      code: label.replace(' ', ''),
                      label,
                    })),
                  },
                ],
                openCount: 1,
                maxOpen: 10,
                items: [
                  ['r1', 'open', '25 kg', null, '2026-11-10T10:00:00Z', null],
                  ['r2', 'approved', '20 kg', null, '2026-11-02T10:00:00Z', '2026-11-04T10:00:00Z'],
                  ['r3', 'mapped', '5 kg', null, '2026-10-28T10:00:00Z', '2026-10-30T10:00:00Z'],
                  [
                    'r4',
                    'declined',
                    '50 kg',
                    'We do not stock a 50 kg pack of this product.',
                    '2026-10-20T10:00:00Z',
                    '2026-10-22T10:00:00Z',
                  ],
                ].map(([id, status, label, reason, createdAt, decidedAt]) => ({
                  id: id!,
                  offerId: 'o1',
                  productId: 'p1',
                  productCode: 'MP-004127',
                  status: status as 'open',
                  options: [
                    {
                      attributeCode: 'size',
                      attributeName: 'Size',
                      optionCode: label!.replace(' ', ''),
                      optionLabel: label!,
                    },
                  ],
                  resolvedVariantId: null,
                  declineReason: reason ?? null,
                  createdAt: createdAt!,
                  decidedAt: decidedAt ?? null,
                })),
              }
            : null
        }
      />
    </div>
  </NextIntlClientProvider>,
);
