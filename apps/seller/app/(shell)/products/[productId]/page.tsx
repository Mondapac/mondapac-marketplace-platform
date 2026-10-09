import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { catalogStateFor } from '../../../../src/catalog/catalog-states.tsx';
import { ProductDetail } from '../../../../src/catalog/product-detail.tsx';
import type { ProductView } from '../../../../src/catalog/types.ts';
import { isUuid, loadCatalogPage } from '../../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.products.title') };
}

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
  return (
    <SellerShell session={page.session} activeId="s_products" title={title}>
      <ProductDetail product={page.body} />
    </SellerShell>
  );
}
