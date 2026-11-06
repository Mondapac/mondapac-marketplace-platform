import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { VariantsTable } from '../../src/catalog/variants-table.tsx';
import type { TableRow } from '../../src/catalog/variants-table-logic.ts';

const params = new URLSearchParams(location.search);
const scenario = params.get('s') ?? 'seller';
const platform = scenario === 'platform';

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
  ...over,
});
const rows: TableRow[] = [
  {
    v: 1,
    name: platform ? '1 kg' : 'Mango · 1 L',
    amount: '420',
    n: 36,
    over: { variantSku: 'MJ-1L' },
  },
  { v: 2, name: platform ? '5 kg' : 'Mango · 2 L', amount: '750', n: 0, over: {} },
  {
    v: 3,
    name: platform ? '10 kg' : 'Guava · 1 L',
    amount: '440',
    n: 12,
    over: { selling: false },
  },
  {
    v: 4,
    name: platform ? '20 kg' : 'Guava · 2 L',
    amount: '780',
    n: 8,
    over: { variantSku: 'GJ-2L' },
  },
].map((r) => ({
  variantId: `v${r.v}`,
  label: r.name,
  price: price(`v${r.v}`, r.amount),
  stock: stock(`v${r.v}`, r.n),
  unit: unit(r.v, r.name, r.over),
}));

window.fetch = ((_input: string) =>
  Promise.resolve(
    new Response(JSON.stringify({ code: 'offer.sku-taken', statusCode: 409 }), { status: 409 }),
  )) as typeof fetch;

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
        units={{ canEdit: true, productScope: platform ? 'PLATFORM' : 'SELLER', sellerSku: 'MJ' }}
        csrfToken="csrf"
      />
    </div>
  </NextIntlClientProvider>,
);
