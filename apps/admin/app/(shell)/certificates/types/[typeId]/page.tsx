import { LoadError, PageHeader } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { TypeDetailView } from '../../../../../src/certificates/type-registry/type-detail.tsx';
import {
  API_ISSUERS,
  API_TYPES,
  POLICY_VIEW_PERMISSION,
  TYPE_EDIT_PERMISSION,
  TYPE_VIEW_PERMISSION,
  type TypeDetail,
} from '../../../../../src/certificates/type-registry/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.types.detail.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One certificate type (certificates design CA4): the published revision, waiting changes, actions. */
export default async function TypePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly typeId: string }>;
  readonly searchParams: Promise<{ readonly done?: string | readonly string[] }>;
}) {
  const { typeId } = await params;
  const { done } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <PageHeader title={title} className="mb-4" />
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'unavailable' | 'not-found') => (
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates/types">
          {t('certificates.types.detail.back')}
        </a>
      </p>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.types.detail.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`certificates.types.detail.${key}`)}</p>
      )}
    </>
  );
  if (!keys.includes(TYPE_VIEW_PERMISSION)) return shell(message('no-access'));
  if (!UUID.test(typeId)) return shell(message('not-found'));
  const result = await serverGet<TypeDetail>(`${API_TYPES}/${typeId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind === 'not-found') return shell(message('not-found'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  // A proposed type that needs an issuer: warn when none is active (a warning, not a block).
  let hasActiveIssuer: boolean | null = null;
  const body = result.body;
  if (
    body.status === 'proposed' &&
    body.published.content.requiresIssuerRegistry === true &&
    keys.includes('certification.issuer.view')
  ) {
    const issuers = await serverGet<{ readonly items: readonly unknown[] }>(
      `${API_ISSUERS}?typeId=${typeId}&state=active&limit=1`,
    );
    if (issuers.kind === 'ok') hasActiveIssuer = issuers.body.items.length > 0;
  }
  const locale = await getLocale();
  const language = locale.split('-')[0] ?? locale;
  const locales = result.body.published.content.locales ?? {};
  const name = locales[locale]?.name ?? locales[language]?.name ?? result.body.code;
  return shell(
    <>
      <p className="mb-4">
        <a className="font-medium text-link underline" href="/certificates/types">
          {t('certificates.types.detail.back')}
        </a>
      </p>
      <TypeDetailView
        type={result.body}
        name={name}
        canEdit={keys.includes(TYPE_EDIT_PERMISSION)}
        canViewPolicy={keys.includes(POLICY_VIEW_PERMISSION)}
        csrfToken={gate.session.csrfToken}
        accountId={gate.session.accountId}
        hasActiveIssuer={hasActiveIssuer}
        done={typeof done === 'string' ? done : null}
      />
    </>,
  );
}
