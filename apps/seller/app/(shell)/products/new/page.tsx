import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { blankProduct } from '../../../../src/catalog/add-offer.tsx';
import { EditForm } from '../../../../src/catalog/edit-form.tsx';
import { EDIT_PERMISSION, type ProductOptions } from '../../../../src/catalog/types.ts';
import { loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.create.title') };
}

export default async function NewProductPage() {
  const t = await getTranslations();
  const title = t('catalog.create.title');
  const page = await loadCatalogPage<ProductOptions>(
    'catalog/seller/products/options',
    EDIT_PERMISSION,
  );
  const state = await catalogStateFor(page, 's_products', title);
  if (state !== null || page.kind !== 'ok') return state;
  return (
    <SellerShell session={page.session} activeId="s_products" title={title}>
      {page.body.sellerCanCreateProduct ? (
        <EditForm
          product={blankProduct(page.body)}
          photos={null}
          locales={page.body.locales.supported}
          defaultLocale={page.body.locales.default}
          marketName={panelConfig().marketName}
          csrfToken={page.session.csrfToken}
          add={{ options: page.body }}
        />
      ) : (
        <>
          <h1 className="mb-2 text-2xl font-semibold">{title}</h1>
          <p className="text-fg-muted">{t('catalog.create.closed')}</p>
        </>
      )}
    </SellerShell>
  );
}
