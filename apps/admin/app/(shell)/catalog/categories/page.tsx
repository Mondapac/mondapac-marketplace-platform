import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CategoriesView } from '../../../../src/categories/categories-view.tsx';
import {
  EDIT_PERMISSION,
  READ_PERMISSION,
  RESTRUCTURE_PERMISSION,
} from '../../../../src/categories/types.ts';
import {
  EDIT_ATTRIBUTES_PERMISSION,
  VIEW_ATTRIBUTES_PERMISSION,
  type AttributeAccess,
} from '../../../../src/categories/attribute-links-model.ts';
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
  const attributeAccess: AttributeAccess = permissionKeys.includes(EDIT_ATTRIBUTES_PERMISSION)
    ? 'edit'
    : permissionKeys.includes(VIEW_ATTRIBUTES_PERMISSION)
      ? 'view'
      : 'none';
  return (
    <AdminShell session={gate.session} activeId="categories" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) ? (
        <CategoriesView
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          canRestructure={permissionKeys.includes(RESTRUCTURE_PERMISSION)}
          attributeAccess={attributeAccess}
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
