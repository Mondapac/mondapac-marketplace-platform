import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { TypeDetailView } from '../../src/certificates/type-registry/type-detail.tsx';
import { TypeNewForm } from '../../src/certificates/type-registry/type-new-form.tsx';
import { TypesTable } from '../../src/certificates/type-registry/types-table.tsx';
import { TypesToolbar } from '../../src/certificates/type-registry/types-toolbar.tsx';
import type {
  TypeDetail,
  TypeNewOptions,
  TypeRow,
} from '../../src/certificates/type-registry/types.ts';

const ID = '0190a000-0000-7000-8000-0000000000b1';
const options: TypeNewOptions = {
  locales: ['en-AU'],
  verificationModes: ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'],
  defaultBases: ['SELLER_REQUIRED', 'NOT_APPLICABLE'],
  badgeArtworkKeys: ['text', 'halal'],
  limits: {
    codeMinLength: 2,
    codeMaxLength: 32,
    nameMaxLength: 80,
    descriptionMaxLength: 500,
    claimTermsPerLocale: 200,
    claimTermMaxLength: 100,
    reasonMaxLength: 500,
  },
};
const row = (code: string, name: string, status: TypeRow['status'], mode: string): TypeRow => ({
  typeId: `0190a000-0000-7000-8000-${String(code.length).padStart(12, '0')}`,
  code,
  status,
  verificationMode: mode,
  version: 1,
  publishedRevisionNo: 1,
  names: { 'en-AU': name },
  pending: [],
});
const rows = [
  row('halal', 'Halal', 'active', 'THIRD_PARTY_DOCUMENT'),
  row('organic', 'Organic', 'proposed', 'THIRD_PARTY_DOCUMENT'),
  row('kosher', 'Kosher', 'inactive', 'THIRD_PARTY_DOCUMENT'),
  row('zorbex', 'Zorbex', 'rejected', 'SELF_DECLARATION'),
];
const proposed = (account: string): TypeDetail => ({
  typeId: ID,
  code: 'organic',
  status: 'proposed',
  version: 1,
  published: {
    revisionNo: 1,
    createdAt: '2026-11-22T01:00:00.000Z',
    content: {
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      defaultBasis: 'SELLER_REQUIRED',
      autoApproveSelfDeclaration: false,
      badgeIconKey: 'text',
      locales: {
        'en-AU': {
          name: 'Organic',
          customerDescription:
            'The seller holds an organic certificate from a certifying body that the platform has reviewed.',
          claimTerms: ['organic', 'certified organic'],
        },
      },
    },
  },
  pendingRevision: null,
  pendingReactivation: null,
  pendingCreation: {
    id: 'prop-1',
    proposer: { accountId: account },
    proposedAt: '2026-11-22T01:00:00.000Z',
    state: 'pending',
    version: 1,
    reason: { state: 'given', text: 'Customers keep asking for organic products.' },
    diff: [],
    actions:
      account === 'me'
        ? {
            approve: { allowed: false, code: 'review.second-admin-required' },
            reject: { allowed: false, code: 'review.proposer-cannot-reject' },
            withdraw: { allowed: true },
          }
        : {
            approve: { allowed: true },
            reject: { allowed: true },
            withdraw: { allowed: false, code: 'review.not-proposer' },
          },
  },
});

const view = new URLSearchParams(location.search).get('view') ?? 'new';
const body =
  view === 'list' ? (
    <div className="flex flex-col gap-4">
      <TypesToolbar canEdit closed={false} />
      <TypesTable rows={rows} />
    </div>
  ) : view === 'proposed-other' ? (
    <TypeDetailView
      type={proposed('someone-else')}
      name="Organic"
      canEdit
      csrfToken="c"
      accountId="me"
      hasActiveIssuer={false}
    />
  ) : view === 'proposed' ? (
    <TypeDetailView
      type={proposed('me')}
      name="Organic"
      canEdit
      csrfToken="c"
      accountId="me"
      hasActiveIssuer
    />
  ) : (
    <TypeNewForm options={options} csrfToken="c" />
  );

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-4xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.certificates.title}</h1>
      {view === 'new' ? (
        <h2 className="mb-2 text-xl font-semibold">{messages.certificates.types.fields.title}</h2>
      ) : null}
      {body}
    </main>
  </NextIntlClientProvider>,
);
