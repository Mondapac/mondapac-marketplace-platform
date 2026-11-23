import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CategoryImport } from '../../../../../src/categories/import/category-import.tsx';
import { IMPORT_PERMISSION } from '../../../../../src/categories/import/import-model.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('categories.import.title') };
}

export default async function CategoryImportPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('categories.import.title');
  return (
    <AdminShell session={gate.session} activeId="categories" title={title}>
      <PageHeader title={title} className="mb-4" />
      {gate.session.permissionKeys.includes(IMPORT_PERMISSION) ? (
        <CategoryImport csrfToken={gate.session.csrfToken} />
      ) : (
        <>
          <p className="text-fg-muted">{t('categories.import.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/catalog/categories">
              {t('categories.import.back')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
