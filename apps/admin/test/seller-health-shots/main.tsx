import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { SellersList } from '../../src/sellers/sellers-list.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const scenario = new URLSearchParams(window.location.search).get('s') ?? 'list';
// `before` leaves the health out, as the list did before the column: the same rows otherwise.
const withHealth = scenario !== 'before';
type Band = 'healthy' | 'at-risk' | 'unhealthy';
const health = (kind: 'scored' | 'new' | 'no-data', band: Band | null, score: number | null) =>
  withHealth ? { day: '2026-11-10', kind, band, score, lowestMetric: null } : undefined;
const row = (n: number, storeName: string, h: ReturnType<typeof health> | null) => ({
  sellerId: id(n),
  storeName,
  slug: storeName.toLowerCase().replace(/ /g, '-'),
  status: 'approved',
  owner: { displayName: `Owner ${n}`, email: `owner${n}@example.com` },
  origin: 'self' as const,
  kind: null,
  submittedAt: '2026-10-08T01:00:00.000Z',
  serviceAreaCode: 'greater-brisbane',
  serviceAreaName: 'Greater Brisbane',
  timezone: 'Australia/Brisbane',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastChangedAt: '2026-11-08T01:00:00.000Z',
  ...(h === undefined ? {} : { health: h }),
});
const items = [
  row(1, 'Cedar Lane Halal Meats', health('scored', 'healthy', 91)),
  row(2, 'Sunnybank Spice House', health('scored', 'at-risk', 55)),
  row(3, 'Mt Gravatt Butchery', health('scored', 'unhealthy', 20)),
  row(4, 'Fresh Start Bakery', health('new', null, null)),
  row(5, 'Logan Dates and Nuts', health('no-data', null, null)),
  row(6, 'Brand New Store', withHealth ? null : undefined),
];
const body = {
  tab: 'approved',
  items,
  next: null,
  counts: { awaitingReview: { onboarding: 0, identityChange: 0 }, incomplete: 0, all: 6 },
  areas: [{ code: 'greater-brisbane', name: 'Greater Brisbane' }],
  stateCounts: { changesNeeded: 0, notApproved: 0, approved: 6, suspended: 0 },
  healthUnavailable: scenario === 'unavailable',
};
window.fetch = () =>
  Promise.resolve(
    new Response(
      JSON.stringify(
        scenario === 'unavailable'
          ? { ...body, items: items.map((i) => ({ ...i, health: null })) }
          : body,
      ),
      { status: 200 },
    ),
  );

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <SellersList csrfToken="tok" canReview />
    </main>
  </NextIntlClientProvider>,
);
