import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CategoriesTabs } from '../../../../src/categories/proposals/categories-tabs.tsx';
import {
  DECIDE_PERMISSION,
  PROMOTE_MERGE_PERMISSION,
} from '../../../../src/categories/proposals/types.ts';
import {
  EDIT_PERMISSION,
  READ_PERMISSION,
  RESTRUCTURE_PERMISSION,
} from '../../../../src/categories/types.ts';
import { IMPORT_PERMISSION } from '../../../../src/categories/import/import-model.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('categories.title') };
}

export default async function CategoriesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('categories.title');
  const { permissionKeys } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="categories" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) ? (
        <CategoriesTabs
          canDecide={permissionKeys.includes(DECIDE_PERMISSION)}
          canPromote={permissionKeys.includes(PROMOTE_MERGE_PERMISSION)}
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          canRestructure={permissionKeys.includes(RESTRUCTURE_PERMISSION)}
          canImport={permissionKeys.includes(IMPORT_PERMISSION)}
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('categories.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('categories.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
