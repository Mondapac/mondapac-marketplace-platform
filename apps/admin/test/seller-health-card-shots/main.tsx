import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { SellerHealthCard } from '../../src/sellers/health-card.tsx';
import type { HealthCardRead, SellerHealthRead } from '../../src/sellers/health-types.ts';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'at-risk';
const SELLER = '0190a000-0000-7000-8000-000000000001';
const days = (scores: (number | null)[]) =>
  scores.map((score, i) => ({
    day: `2026-10-${String(12 + i).padStart(2, '0')}`,
    kind: 'scored' as const,
    score,
  }));
const card = (
  band: 'healthy' | 'at-risk' | 'unhealthy',
  score: number,
  lowest: string,
): HealthCardRead => ({
  day: '2026-11-10',
  kind: 'scored',
  band,
  score,
  lowestMetric: lowest,
  formulaVersion: '1',
  computedAt: '2026-11-11T02:00:00Z',
  orders: 40,
  metrics: [
    { metric: 'seller-cancellations', kind: 'no-data' },
    { metric: 'late-ready', kind: 'scored', band, score },
    { metric: 'customer-rating', kind: 'scored', band: 'healthy', score: 92 },
    { metric: 'lost-disputes', kind: 'scored', band: 'healthy', score: 100 },
    { metric: 'reports', kind: 'scored', band: 'at-risk', score: 61 },
  ],
});
const trend = days([82, 80, 78, 75, 74, 70, 66, 62, 60, 58]);
const reads: Record<string, SellerHealthRead> = {
  'at-risk': { sellerId: SELLER, current: card('at-risk', 58, 'late-ready'), trend },
  healthy: { sellerId: SELLER, current: card('healthy', 91, 'reports'), trend: days([90, 91, 91]) },
  unhealthy: { sellerId: SELLER, current: card('unhealthy', 24, 'late-ready'), trend },
  none: { sellerId: SELLER, current: null, trend: [] },
  new: {
    sellerId: SELLER,
    current: {
      ...card('healthy', 0, 'reports'),
      kind: 'new',
      band: null,
      score: null,
      metrics: [],
    },
    trend: [],
  },
};
const queuedStatus = scenario === 'already' ? 'already-queued' : 'queued';
window.fetch = () =>
  Promise.resolve(
    scenario === 'failed'
      ? new Response(JSON.stringify({ code: 'sellers.unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ status: queuedStatus }), { status: 202 }),
  );
const read = reads[['queued', 'already', 'failed'].includes(scenario) ? 'at-risk' : scenario]!;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    <main className="mx-auto max-w-3xl p-4 md:p-6">
      <SellerHealthCard sellerId={SELLER} initial={read} canRecalculate csrfToken="tok" />
    </main>
  </NextIntlClientProvider>,
);
