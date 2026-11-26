import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { OfferDetail } from '../../src/catalog/offer-detail.tsx';
import type { OfferView } from '../../src/catalog/types.ts';

// A stand-in for the submit preview bar (risk-based Offer approval slice 7b): a draft Offer page,
// with the dry run's answer served by a fetch stub per scenario.

const scenario = new URLSearchParams(globalThis.location.search).get('s') ?? 'publish';
const answers: Record<string, { status: number; body: unknown }> = {
  publish: { status: 200, body: { outcome: 'publish', reasons: [] } },
  'publish-held-price': { status: 200, body: { outcome: 'publish', reasons: [] } },
  'review-told': {
    status: 200,
    body: {
      outcome: 'review',
      reasons: ['certificate-badge', 'handling', 'contact-text', 'held-for-review'],
    },
  },
  'review-hidden': { status: 200, body: { outcome: 'review', reasons: ['held-for-review'] } },
  unavailable: { status: 503, body: { statusCode: 503, code: 'access.unavailable' } },
};
const answer = answers[scenario] ?? answers.publish!;
globalThis.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    }),
  );

const offer: OfferView = {
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
  status: 'draft',
  listed: false,
  offSaleCauses: [],
  handling: scenario === 'review-told' ? 'REPACKED' : 'SEALED_ORIGINAL',
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-11-19T01:00:00.000Z',
  version: 2,
};

const root = createRoot(globalThis.document.getElementById('root')!);
const node = await OfferDetail({
  offer,
  canEdit: true,
  csrfToken: 'csrf',
  heldPrice: scenario === 'publish-held-price',
});
root.render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-5xl p-4">{node}</main>
  </NextIntlClientProvider>,
);
