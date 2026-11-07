import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { ProductCreateForm } from '../../../../../src/catalog/product-form/create-form.tsx';
import { EDIT_PERMISSION } from '../../../../../src/catalog/product-form/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.productForm.create.title') };
}

export default async function AddProductPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.productForm.create.title');
  const allowed = gate.session.permissionKeys.includes(EDIT_PERMISSION);
  return (
    <AdminShell session={gate.session} activeId="products" title={title}>
      {allowed ? (
        <ProductCreateForm csrfToken={gate.session.csrfToken} />
      ) : (
        <>
          <p className="text-fg-muted">{t('catalog.productForm.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/catalog/products">
              {t('catalog.productForm.back')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
