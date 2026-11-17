import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { CertificatesTabs } from '../../../../src/certificates/tabs.tsx';
import { TypesTable } from '../../../../src/certificates/type-registry/types-table.tsx';
import {
  API_TYPES,
  TYPE_VIEW_PERMISSION,
  type TypeList,
} from '../../../../src/certificates/type-registry/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.types.title') };
}

/** Certificates > Types (certificates design CA4): the certificate types of the Market. */
export default async function TypesPage() {
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
  const message = (key: 'no-access' | 'unavailable') =>
    key === 'unavailable' ? (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('certificates.types.unavailable')}
        retryLabel={t('load.retry')}
      />
    ) : (
      <>
        <p className="text-fg-muted">{t('certificates.types.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('certificates.queue.back-home')}
          </a>
        </p>
      </>
    );
  if (!keys.includes(TYPE_VIEW_PERMISSION)) return shell(message('no-access'));
  const result = await serverGet<TypeList>(API_TYPES);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  return shell(
    <div className="flex flex-col gap-4">
      <CertificatesTabs active="types" permissionKeys={keys} />
      <TypesTable rows={result.body.items} />
    </div>,
  );
}
