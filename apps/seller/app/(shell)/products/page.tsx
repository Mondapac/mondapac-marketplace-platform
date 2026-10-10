import { getTranslations } from 'next-intl/server';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { Pager } from '../../../src/catalog/pager.tsx';
import { ProductsTable } from '../../../src/catalog/products-table.tsx';
import { EDIT_PERMISSION, type Page, type ProductListItem } from '../../../src/catalog/types.ts';
import { afterIdParam, loadCatalogPage } from '../../../src/server/catalog-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.products.title') };
}

export default async function ProductsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const after = afterIdParam((await searchParams).after);
  const t = await getTranslations();
  const title = t('catalog.products.title');
  const page = await loadCatalogPage<Page<ProductListItem>>(
    `catalog/seller/products${after === undefined ? '' : `?afterId=${after}`}`,
  );
  const state = await catalogStateFor(page, 's_products', title);
  if (state !== null || page.kind !== 'ok') return state;
  return (
    <SellerShell session={page.session} activeId="s_products" title={title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {page.session.permissionKeys.includes(EDIT_PERMISSION) ? (
          <a className="font-medium text-link underline" href="/products/new">
            {t('catalog.products.new')}
          </a>
        ) : null}
      </div>
      <ProductsTable items={page.body.items} />
      <Pager basePath="/products" nextAfterId={page.body.nextAfterId} />
    </SellerShell>
  );
}
