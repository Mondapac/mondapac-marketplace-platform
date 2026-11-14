import { Tabs } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { RequestView } from '../../src/certificates/requests/request-view.tsx';
import { RequestsTable } from '../../src/certificates/requests/requests-table.tsx';
import type { RequestDetail, RequestRow } from '../../src/certificates/requests/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const rows: RequestRow[] = [
  {
    issuerRequestId: id(1),
    version: 2,
    typeCode: 'halal',
    sellerId: id(300),
    storeName: 'Logan Road Grocer',
    documentCount: 2,
    createdAt: '2026-11-08T01:00:00Z',
  },
  {
    issuerRequestId: id(2),
    version: 1,
    typeCode: 'halal',
    sellerId: id(301),
    storeName: null,
    documentCount: 0,
    createdAt: '2026-11-09T01:00:00Z',
  },
];
const detail: RequestDetail = {
  issuerRequestId: id(1),
  version: 2,
  state: 'open',
  typeCode: 'halal',
  sellerId: id(300),
  storeName: 'Logan Road Grocer',
  typedIssuerName: 'Brisbane Halal Board of Certification',
  documents: [{ position: 0, mediaType: 'application/pdf', byteSize: 1258291, pageCount: 2 }],
  createdAt: '2026-11-08T01:00:00Z',
  answer: null,
  activeIssuers: [{ issuerId: id(5), displayName: 'Halal Certification Authority' }],
  reasons: [{ code: 'not-an-issuer', label: 'This is not a certificate issuer.' }],
};
const names = new Map([['halal', 'Halal']]);
const view = new URLSearchParams(location.search).get('view') ?? 'queue';

const tabs = (
  <Tabs
    label={messages.certificates.tabs.label}
    activeId="requests"
    items={[
      { id: 'queue', label: messages.certificates.tabs.queue, href: '/certificates' },
      { id: 'issuers', label: messages.certificates.tabs.issuers, href: '/certificates/issuers' },
      {
        id: 'requests',
        label: messages.certificates.tabs.requests,
        href: '/certificates/issuer-requests',
      },
    ]}
  />
);

function Body() {
  if (view === 'queue') {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <p className="text-sm text-fg-muted">2 requests are open, oldest first.</p>
        <RequestsTable rows={rows} typeNames={names} morePages={false} />
      </div>
    );
  }
  return <RequestView request={detail} typeName="Halal" canAnswer csrfToken="t" />;
}
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">
        {view === 'queue'
          ? messages.certificates.title
          : messages.certificates.requests.detail.title}
      </h1>
      <Body />
    </main>
  </NextIntlClientProvider>,
);
