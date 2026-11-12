import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { HealthQueue } from '../../src/sellers/health-queue.tsx';
import type { HealthQueueRead } from '../../src/sellers/health-types.ts';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'list';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, storeName: string | null, score: number, lowestMetric: string) => ({
  sellerId: id(n),
  storeName,
  slug: storeName === null ? null : storeName.toLowerCase().replace(/ /g, '-'),
  day: '2026-11-10',
  score,
  lowestMetric,
});
const queues: Record<string, HealthQueueRead> = {
  list: {
    truncated: false,
    items: [
      item(1, 'Mt Gravatt Butchery', 12, 'late-ready'),
      item(2, 'Sunnybank Spice House', 20, 'reports'),
      item(3, null, 27, 'lost-disputes'),
      item(4, 'Logan Dates and Nuts', 31, 'customer-rating'),
    ],
  },
  truncated: {
    truncated: true,
    items: [
      item(1, 'Mt Gravatt Butchery', 12, 'late-ready'),
      item(2, 'Sunnybank Spice House', 20, 'reports'),
    ],
  },
  empty: { truncated: false, items: [] },
};

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    <main className="mx-auto max-w-5xl p-4 md:p-6">
      {scenario === 'empty' ? null : (
        <h1 className="mb-4 text-2xl font-semibold">{messages.sellers['health-queue'].title}</h1>
      )}
      <HealthQueue queue={queues[scenario]!} />
    </main>
  </NextIntlClientProvider>,
);
