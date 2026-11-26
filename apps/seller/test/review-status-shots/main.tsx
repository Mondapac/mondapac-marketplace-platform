import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { OfferDetail } from '../../src/catalog/offer-detail.tsx';
import { ProbationBar } from '../../src/catalog/probation-bar.tsx';
import type { OfferView, ReviewStanding } from '../../src/catalog/types.ts';

// A stand-in for the seller's review status (risk-based Offer approval slice 7): an Offer page
// with a take-down notice and the probation bar, and the Offers page header with the bar.

const scenario = new URLSearchParams(globalThis.location.search).get('s') ?? 'takedown';
const offer = (over: Partial<OfferView> = {}): OfferView => ({
  offerId: '0190a000-0000-7000-8000-0000000000a1',
  productId: '0190a000-0000-7000-8000-0000000000b1',
  product: {
    productCode: 'P00000001',
    typeCode: 'grocery',
    name: 'Cold pressed olive oil 1 L',
    scope: 'PLATFORM',
    primaryImageId: null,
  },
  sellerSku: 'OIL-1L',
  conditionCode: 'new',
  description: { 'en-AU': 'Cold pressed extra virgin olive oil.' },
  status: 'published',
  listed: true,
  offSaleCauses: [],
  handling: 'SEALED_ORIGINAL',
  attestationRecorded: true,
  submittedAt: '2026-11-20T01:00:00.000Z',
  firstPublishedAt: '2026-11-21T01:00:00.000Z',
  createdAt: '2026-11-19T01:00:00.000Z',
  version: 5,
  ...over,
});
const probation = (count: number, target: number, restarted = false): ReviewStanding => ({
  status: 'probation',
  count,
  target,
  restarted,
});
const down = (reasonCode: string) => ({ reasonCode, at: '2026-11-26T01:00:00.000Z' });

const root = createRoot(globalThis.document.getElementById('root')!);
const bar = async (s: ReviewStanding) => (
  <div className="mb-4">{await ProbationBar({ standing: s })}</div>
);
const page = async () => {
  switch (scenario) {
    case 'takedown':
      return OfferDetail({
        offer: offer({
          status: 'changes-needed',
          listed: false,
          takeDown: down('description-claim'),
        }),
      });
    case 'takedown-unknown':
      return OfferDetail({
        offer: offer({ status: 'changes-needed', listed: false, takeDown: down('brand-new-code') }),
      });
    case 'takedown-restarted':
      return OfferDetail({
        offer: offer({
          status: 'changes-needed',
          listed: false,
          takeDown: down('handling-unclear'),
        }),
        standing: probation(0, 5, true),
      });
    case 'send-back':
      return OfferDetail({
        offer: offer({
          status: 'changes-needed',
          listed: false,
          firstPublishedAt: null,
          takeDown: null,
        }),
      });
    case 'probation-offer':
      return OfferDetail({
        offer: offer({ status: 'pending-first-publish', listed: false, firstPublishedAt: null }),
        standing: probation(3, 10),
      });
    default:
      return bar(probation(3, 10));
  }
};
const node = await page();
root.render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-5xl p-4">
      {scenario === 'probation-list' ? (
        <h1 className="mb-4 text-xl font-semibold">Offers</h1>
      ) : null}
      {node}
    </main>
  </NextIntlClientProvider>,
);
