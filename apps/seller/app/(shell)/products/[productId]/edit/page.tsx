import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../../src/catalog/catalog-states.tsx';
import { EditForm } from '../../../../../src/catalog/edit-form.tsx';
import {
  EDIT_PERMISSION,
  type ProductOptions,
  type ProductView,
} from '../../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.edit.title') };
}

export default async function EditProductPage({
  params,
}: {
  readonly params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;
  if (!isUuid(productId)) notFound();
  const t = await getTranslations();
  const title = t('catalog.edit.title');
  const page = await loadCatalogPage<ProductView>(
    `catalog/seller/products/${productId}`,
    EDIT_PERMISSION,
  );
  const state = await catalogStateFor(page, 's_products', title);
  if (state !== null || page.kind !== 'ok') return state;
  const options = await loadCatalogPage<ProductOptions>(
    'catalog/seller/products/options',
    EDIT_PERMISSION,
  );
  if (options.kind !== 'ok') return catalogStateFor(options, 's_products', title);
  return (
    <SellerShell session={page.session} activeId="s_products" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{page.body.productCode}</h1>
      <div className="max-w-(--mp-size-form-max)">
        <EditForm
          product={page.body}
          locales={options.body.locales.supported}
          csrfToken={page.session.csrfToken}
        />
      </div>
    </SellerShell>
  );
}
