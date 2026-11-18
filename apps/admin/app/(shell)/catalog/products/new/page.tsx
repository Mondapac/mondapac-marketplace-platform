import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { panelConfig } from '../../../../../src/server/config.ts';
import { displayZone } from '../../../../../src/shared/format.ts';
import { ProductAdd } from '../../../../../src/catalog/product-form/add-form.tsx';
import {
  EDIT_PERMISSION,
  TOPIC_READ_PERMISSION,
} from '../../../../../src/catalog/product-form/types.ts';

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
        <ProductAdd
          csrfToken={gate.session.csrfToken}
          marketName={panelConfig().marketName}
          timeZone={displayZone(gate.session.timezone)}
          canReadTags={gate.session.permissionKeys.includes(TOPIC_READ_PERMISSION)}
          permissionKeys={gate.session.permissionKeys}
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
