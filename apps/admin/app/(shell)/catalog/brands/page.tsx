import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { BrandsView } from '../../../../src/brands/brands-view.tsx';
import { EDIT_PERMISSION, READ_PERMISSION } from '../../../../src/brands/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('brands.title') };
}

export default async function BrandsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('brands.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="brands" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) ? (
        <BrandsView canEdit={permissionKeys.includes(EDIT_PERMISSION)} csrfToken={csrfToken} />
      ) : (
        <>
          <p className="text-fg-muted">{t('brands.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('brands.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
