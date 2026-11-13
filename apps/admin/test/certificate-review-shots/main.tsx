import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { CertificateQueue } from '../../src/certificates/queue.tsx';
import { ReviewView } from '../../src/certificates/review/review-view.tsx';
import type { ReviewPage } from '../../src/certificates/review/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const page: ReviewPage = {
  certificate: {
    certificateId: id(1),
    sellerId: id(300),
    typeCode: 'halal',
    status: 'awaiting-review',
    version: 4,
    createdAt: '2026-11-01T00:00:00Z',
  },
  submission: {
    submissionId: id(2),
    submissionNo: 2,
    kind: 'resubmission',
    pending: true,
    verificationMode: 'third-party-document',
    requiresDocument: true,
    requiresExpiry: true,
    issuer: {
      issuerId: id(5),
      displayName: 'Halal Certification Authority',
      state: 'closed-to-new',
    },
    certificateNumber: 'HC-2026-0042',
    issueDate: '2026-01-01',
    expiryDate: '2027-01-01',
    selfDeclared: null,
    selfDeclarationNote: null,
    submittedZone: 'Australia/Brisbane',
    submittedAt: '2026-11-09T01:00:00Z',
  },
  documents: [{ position: 0, mediaType: 'application/pdf', byteSize: 1258291, pageCount: 2 }],
  checks: [
    { code: 'number-readable', required: true, result: null, recordedAt: null },
    { code: 'seal', required: true, result: 'done', recordedAt: '2026-11-09T02:00:00Z' },
    { code: 'expiry', required: false, result: 'problem', recordedAt: '2026-11-09T02:00:00Z' },
  ],
  scope: null,
  confirmation: null,
  reasons: {
    'changes-requested': [{ code: 'unreadable', check: null, nextStep: 'Send a clearer scan' }],
    declined: [{ code: 'not-accepted', check: null, nextStep: 'Use an accepted issuer' }],
  },
  duplicateHints: [{ kind: 'number', certificateId: id(9), storeName: null }],
  business: {
    status: 'ok',
    businessName: 'Logan Road Grocer Pty Ltd',
    storeName: 'Logan Road Grocer',
  },
  history: [
    {
      fromStatus: null,
      toStatus: 'awaiting-review',
      occurredAt: '2026-11-09T01:00:00Z',
      actorKind: 'seller',
      reasonCode: null,
    },
  ],
  decision: null,
};
const view = new URLSearchParams(location.search).get('view') ?? 'review';
const names = new Map([['halal', 'Halal']]);

function Body() {
  if (view === 'queue') {
    return (
      <CertificateQueue
        rows={[
          {
            certificateId: id(1),
            version: 4,
            submissionId: id(2),
            submissionNo: 2,
            kind: 'resubmission',
            typeCode: 'halal',
            sellerId: id(300),
            storeName: 'Logan Road Grocer',
            issuerName: 'Halal Certification Authority',
            submittedAt: '2026-11-09T01:00:00Z',
          },
        ]}
        typeNames={names}
        morePages={false}
        canReview
      />
    );
  }
  return <ReviewView page={page} typeName="Halal" canReview canDecide csrfToken="t" />;
}
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.certificates.title}</h1>
      <Body />
    </main>
  </NextIntlClientProvider>,
);
