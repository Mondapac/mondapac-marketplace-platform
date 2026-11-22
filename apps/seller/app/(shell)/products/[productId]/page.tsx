import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { EditForm } from '../../../../src/catalog/edit-form.tsx';
import { ProductDetail } from '../../../../src/catalog/product-detail.tsx';
import {
  EDIT_PERMISSION,
  type PhotoList,
  type ProductOptions,
  type ProductView,
  VIEW_PERMISSION,
} from '../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.products.title') };
}

/** One product: the editable form for a seller who may edit, the read-only detail otherwise. */
export default async function ProductPage({
  params,
}: {
  readonly params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  if (!isUuid(productId)) notFound();
  const t = await getTranslations();
  const title = t('catalog.products.title');
  const page = await loadCatalogPage<ProductView>(`catalog/seller/products/${productId}`);
  const state = await catalogStateFor(page, 's_products', title);
  if (state !== null || page.kind !== 'ok') return state;
  if (!page.session.permissionKeys.includes(EDIT_PERMISSION)) {
    return (
      <SellerShell session={page.session} activeId="s_products" title={title}>
        <ProductDetail product={page.body} canEdit={false} />
      </SellerShell>
    );
  }
  const options = await loadCatalogPage<ProductOptions>(
    'catalog/seller/products/options',
    EDIT_PERMISSION,
  );
  if (options.kind !== 'ok') return catalogStateFor(options, 's_products', title);
  // A photo list that cannot be read leaves the rest of the form usable.
  const photos = await loadCatalogPage<PhotoList>(
    `catalog/seller/products/${productId}/images`,
    VIEW_PERMISSION,
  );
  return (
    <SellerShell session={page.session} activeId="s_products" title={title}>
      <div>
        <EditForm
          // Add sizes changes the product under the form: the form starts again from what is read.
          key={`${page.body.variantModel}-${page.body.version ?? 0}`}
          product={page.body}
          photos={photos.kind === 'ok' ? photos.body.images : null}
          locales={options.body.locales.supported}
          defaultLocale={options.body.locales.default}
          marketName={panelConfig().marketName}
          csrfToken={page.session.csrfToken}
        />
      </div>
    </SellerShell>
  );
}
