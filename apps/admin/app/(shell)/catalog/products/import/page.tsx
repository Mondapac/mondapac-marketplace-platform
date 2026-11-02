import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { ProductsImport } from '../../../../../src/catalog/import/products-import.tsx';
import { IMPORT_PERMISSION } from '../../../../../src/catalog/import/import-types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.import.title') };
}

export default async function ProductsImportPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly id?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.import.title');
  const allowed = gate.session.permissionKeys.includes(IMPORT_PERMISSION);
  const { id } = await searchParams;
  // A notice links here with the import's id; anything that is not a UUID is ignored.
  const openImportId = typeof id === 'string' && UUID.test(id) ? id : null;
  return (
    <AdminShell session={gate.session} activeId="products" title={title}>
      {allowed ? (
        <ProductsImport
          permissionKeys={gate.session.permissionKeys}
          csrfToken={gate.session.csrfToken}
          openImportId={openImportId}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('catalog.import.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/catalog/products">
              {t('catalog.import.back')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
