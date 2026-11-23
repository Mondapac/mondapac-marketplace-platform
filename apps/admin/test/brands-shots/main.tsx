import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { BrandsView } from '../../src/brands/brands-view.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const brand = (n: number, name: string, status: string, origin: string | null, extra = {}) => ({
  id: id(n),
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  summary: null,
  originCountry: origin,
  logoImageId: null,
  logoAlt: null,
  headerImageId: null,
  status,
  proposedBySellerId: null,
  approvedBy: null,
  mergedIntoId: null,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: `2026-10-${10 + n}T01:00:00.000Z`,
  version: 2,
  actions:
    status === 'active'
      ? ['edit', 'merge', 'deactivate']
      : status === 'draft'
        ? ['edit', 'deactivate']
        : [],
  ...extra,
});
const q = new URLSearchParams(location.search);
const draft = q.get('tab') === 'draft';
const items = draft
  ? [
      brand(11, 'Saffron Road Foods', 'draft', 'AU', { proposedBySellerId: id(77) }),
      brand(12, 'Medina Spice House', 'draft', null, { proposedBySellerId: id(78) }),
    ]
  : [
      brand(1, 'Al Noor Foods', 'active', 'AU'),
      brand(2, 'Baraka Dates', 'active', 'SA'),
      brand(3, 'Cedar Kitchen', 'active', 'LB'),
      brand(4, 'Dar Al Sham Sweets', 'active', null),
      brand(5, 'Eastern Harvest', 'active', 'MY'),
    ];
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown = { code: 'not-found' };
  if (path === 'catalog/admin/brands')
    body = {
      items,
      total: draft ? 2 : 61,
      page: 1,
      pageSize: 25,
      paging: 'pages',
      hasNext: !draft,
    };
  else if (path === 'catalog/admin/brands/merge-queue') body = { groups: [] };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <BrandsView
        title={messages.brands.title}
        canEdit
        csrfToken="tok"
        paging="pages"
        accountId={id(99)}
        marketId="AU"
        zone="Australia/Brisbane"
      />
    </main>
  </NextIntlClientProvider>,
);
