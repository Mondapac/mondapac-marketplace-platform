import { LoadError } from '@mondapac/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../../src/server/admin-shell.tsx';
import { panelConfig } from '../../../../../../src/server/config.ts';
import { requireSession } from '../../../../../../src/server/session.ts';
import { displayZone } from '../../../../../../src/shared/format.ts';
import { ProductEdit } from '../../../../../../src/catalog/product-form/edit-form.tsx';
import {
  EDIT_PERMISSION,
  PAUSE_PERMISSION,
} from '../../../../../../src/catalog/product-form/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.productForm.edit.title') };
}

export default async function EditProductPage({
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
  const title = t('catalog.productForm.edit.title');
  const allowed = gate.session.permissionKeys.includes(EDIT_PERMISSION);
  return (
    <AdminShell session={gate.session} activeId="products" title={title}>
      {allowed ? (
        <ProductEdit
          productId={id}
          csrfToken={gate.session.csrfToken}
          marketName={panelConfig().marketName}
          timeZone={displayZone(gate.session.timezone)}
          canPause={gate.session.permissionKeys.includes(PAUSE_PERMISSION)}
        />
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
