import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { typeNames } from '../../../../../src/certificates/format.ts';
import { IssuerDetailView } from '../../../../../src/certificates/issuers/issuer-detail.tsx';
import {
  API_ISSUERS,
  ISSUER_EDIT_PERMISSION,
  ISSUER_VIEW_PERMISSION,
  type IssuerDetail,
  type TypeChoice,
} from '../../../../../src/certificates/issuers/types.ts';
import { TYPE_VIEW_PERMISSION } from '../../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.issuers.detail.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One issuer (certificate issuers design A8): its details, expert approval and Activate. */
export default async function IssuerPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly issuerId: string }>;
  readonly searchParams: Promise<{ readonly activated?: string | readonly string[] }>;
}) {
  const { issuerId } = await params;
  const { activated } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  const back = (
    <p className="mb-4">
      <a className="font-medium text-link underline" href="/certificates/issuers">
        {t('certificates.issuers.detail.back')}
      </a>
    </p>
  );
  const message = (key: 'no-access' | 'unavailable' | 'not-found') => (
    <>
      {back}
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.issuers.detail.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`certificates.issuers.detail.${key}`)}</p>
      )}
    </>
  );
  if (!keys.includes(ISSUER_VIEW_PERMISSION)) return shell(message('no-access'));
  if (!UUID.test(issuerId)) return shell(message('not-found'));

  const [result, types] = await Promise.all([
    serverGet<IssuerDetail>(`${API_ISSUERS}/${issuerId}`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<{ readonly items: readonly TypeChoice[] }>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  return shell(
    <>
      {back}
      <IssuerDetailView
        issuer={result.body}
        typeName={names.get(result.body.typeCode) ?? result.body.typeCode}
        canEdit={keys.includes(ISSUER_EDIT_PERMISSION)}
        csrfToken={gate.session.csrfToken}
        activated={activated === '1'}
      />
    </>,
  );
}
