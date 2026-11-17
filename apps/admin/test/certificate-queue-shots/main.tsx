import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { CertificateQueue } from '../../src/certificates/queue.tsx';
import type { QueueRow } from '../../src/certificates/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const rows: QueueRow[] = [
  [
    'Logan Road Grocer',
    'halal',
    'initial',
    1,
    'Halal Certification Authority',
    '2026-11-04T01:00:00Z',
  ],
  [
    'Sunnybank Butchery',
    'halal',
    'renewal',
    3,
    'Islamic Co-ordinating Council',
    '2026-11-05T22:30:00Z',
  ],
  [null, 'kosher', 'initial', 1, null, '2026-11-07T03:15:00Z'],
  [
    'Mt Gravatt Sweets',
    'halal',
    'resubmission',
    2,
    'Halal Certification Authority',
    '2026-11-09T08:00:00Z',
  ],
].map(([storeName, typeCode, kind, no, issuerName, submittedAt], i) => ({
  certificateId: id(100 + i),
  version: 2,
  submissionId: id(200 + i),
  submissionNo: no as number,
  kind: kind as QueueRow['kind'],
  typeCode: typeCode as string,
  sellerId: id(300 + i),
  storeName: storeName as string | null,
  issuerName: issuerName as string | null,
  submittedAt: submittedAt as string,
}));

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.certificates.title}</h1>
      <p className="mb-4 text-sm text-fg-muted">
        4 submissions are waiting for a decision, oldest first.
      </p>
      <CertificateQueue
        rows={rows}
        typeNames={
          new Map([
            ['halal', 'Halal'],
            ['kosher', 'Kosher'],
          ])
        }
        morePages={false}
      />
    </main>
  </NextIntlClientProvider>,
);
