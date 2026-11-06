import { LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CategoryPageView } from '../../../../../src/categories/category-page-view.tsx';
import { EDIT_PERMISSION, READ_PERMISSION } from '../../../../../src/categories/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('categories.title') };
}

export default async function CategoryPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
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
        <CategoryPageView
          id={id}
          canEdit={permissionKeys.includes(EDIT_PERMISSION)}
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <p className="text-fg-muted">{t('categories.no-access')}</p>
      )}
    </AdminShell>
  );
}
