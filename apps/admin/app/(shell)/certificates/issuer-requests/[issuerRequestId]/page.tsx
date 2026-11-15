import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { typeNames } from '../../../../../src/certificates/format.ts';
import { RequestView } from '../../../../../src/certificates/requests/request-view.tsx';
import {
  API_REQUESTS,
  REQUESTS_ANSWER_PERMISSION,
  REQUESTS_VIEW_PERMISSION,
  type RequestDetail,
} from '../../../../../src/certificates/requests/types.ts';
import { TYPE_VIEW_PERMISSION, type TypesList } from '../../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.requests.detail.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One issuer request (certificate issuers design A13). The read decrypts the seller's text and is
 * audited by the API, so it needs the issuer view permission; answering needs issuer edit.
 */
export default async function IssuerRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly issuerRequestId: string }>;
}) {
  const { issuerRequestId } = await params;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.requests.detail.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={t('certificates.title')}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'unavailable' | 'not-found') => (
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates/issuer-requests">
          {t('certificates.requests.back')}
        </a>
      </p>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.requests.detail.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`certificates.requests.detail.${key}`)}</p>
      )}
    </>
  );
  if (!keys.includes(REQUESTS_VIEW_PERMISSION)) return shell(message('no-access'));
  if (!UUID.test(issuerRequestId)) return shell(message('not-found'));

  const [result, types] = await Promise.all([
    serverGet<RequestDetail>(`${API_REQUESTS}/${issuerRequestId}`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<TypesList>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  return shell(
    <RequestView
      request={result.body}
      typeName={names.get(result.body.typeCode) ?? result.body.typeCode}
      canAnswer={keys.includes(REQUESTS_ANSWER_PERMISSION)}
      csrfToken={gate.session.csrfToken}
    />,
  );
}
