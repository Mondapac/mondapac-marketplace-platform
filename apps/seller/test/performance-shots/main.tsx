import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { Performance } from '../../src/performance/performance.tsx';
import type { HealthCard, OwnHealth } from '../../src/performance/types.ts';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'at-risk';
const card = (over: Partial<HealthCard> = {}): HealthCard => ({
  day: '2026-11-10',
  kind: 'scored',
  band: 'at-risk',
  score: 58,
  lowestMetric: 'late-ready',
  formulaVersion: 'v1',
  computedAt: '2026-11-10T14:00:00.000Z',
  orders: 40,
  metrics: [
    { metric: 'seller-cancellations', kind: 'scored', band: 'healthy', score: 90 },
    { metric: 'late-ready', kind: 'scored', band: 'at-risk', score: 58 },
    { metric: 'customer-rating', kind: 'scored', band: 'healthy', score: 80 },
    { metric: 'lost-disputes', kind: 'scored', band: 'healthy', score: 100 },
    { metric: 'reports', kind: 'no-data' },
  ],
  ...over,
});
const trend = [70, 72, 69, 66, 64, 63, 60, 58].map((score, i) => ({
  day: `2026-11-0${i + 1}`,
  kind: 'scored' as const,
  score,
}));
const scenarios: Record<string, OwnHealth> = {
  'at-risk': { current: card(), trend, refresh: { pending: false, retryAfterSeconds: 0 } },
  cooldown: { current: card(), trend, refresh: { pending: false, retryAfterSeconds: 600 } },
  pending: { current: card(), trend, refresh: { pending: true, retryAfterSeconds: 840 } },
  unhealthy: {
    current: card({
      band: 'unhealthy',
      score: 22,
      lowestMetric: 'customer-rating',
      metrics: [
        { metric: 'seller-cancellations', kind: 'scored', band: 'healthy', score: 85 },
        { metric: 'late-ready', kind: 'scored', band: 'at-risk', score: 50 },
        { metric: 'customer-rating', kind: 'scored', band: 'unhealthy', score: 22 },
        { metric: 'lost-disputes', kind: 'scored', band: 'healthy', score: 95 },
        { metric: 'reports', kind: 'no-data' },
      ],
    }),
    trend,
    refresh: { pending: false, retryAfterSeconds: 0 },
  },
  new: {
    current: card({
      kind: 'new',
      band: null,
      score: null,
      lowestMetric: null,
      orders: 4,
      metrics: [],
    }),
    trend: [],
    refresh: { pending: false, retryAfterSeconds: 0 },
  },
  empty: { current: null, trend: [], refresh: { pending: false, retryAfterSeconds: 0 } },
};

window.fetch = () =>
  Promise.resolve(new Response(JSON.stringify(scenarios[scenario]), { status: 200 }));

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <main className="mx-auto max-w-3xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">Performance</h1>
      <Performance initial={scenarios[scenario]!} csrfToken="tok" />
    </main>
  </NextIntlClientProvider>,
);
