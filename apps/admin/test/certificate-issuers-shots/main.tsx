import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { IssuerDetailView } from '../../src/certificates/issuers/issuer-detail.tsx';
import { IssuersTable } from '../../src/certificates/issuers/issuers-table.tsx';
import { NewIssuer } from '../../src/certificates/issuers/new-issuer.tsx';
import { StateFilter } from '../../src/certificates/issuers/filters.tsx';
import type { IssuerDetail, IssuerRow } from '../../src/certificates/issuers/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (
  n: number,
  name: string,
  state: IssuerRow['state'],
  acc: string | null,
): IssuerRow => ({
  issuerId: id(n),
  typeId: id(900),
  typeCode: 'halal',
  displayName: name,
  accreditationNumber: acc,
  state,
  version: 2,
  stateChangedAt: `2026-11-0${n}T01:00:00Z`,
});
const rows = [
  row(1, 'Halal Certification Authority', 'proposed', 'HCA-0042'),
  row(2, 'Islamic Co-ordinating Council', 'active', null),
  row(3, 'Old Mill Certifiers', 'closed-to-new', 'OMC-7'),
  row(4, 'Eastside Halal Board', 'derecognised', null),
];
const detail: IssuerDetail = {
  ...rows[0]!,
  stateChangedByKind: 'seed',
  expertReferenceRecorded: false,
  affectedCertificates: 0,
  pendingReactivation: null,
  createdAt: '2026-11-01T01:00:00Z',
};
const names = new Map([['halal', 'Halal']]);
const view = new URLSearchParams(location.search).get('view') ?? 'list';

function Body() {
  if (view === 'detail' || view === 'activate') {
    return <IssuerDetailView issuer={detail} typeName="Halal" canEdit csrfToken="t" />;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StateFilter active={null} />
        <NewIssuer
          types={[{ typeId: id(900), code: 'halal', names: { en: 'Halal' } }]}
          typeNames={names}
          csrfToken="t"
        />
      </div>
      <IssuersTable rows={rows} typeNames={names} morePages={false} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.certificates.title}</h1>
      <Body />
    </main>
  </NextIntlClientProvider>,
);
