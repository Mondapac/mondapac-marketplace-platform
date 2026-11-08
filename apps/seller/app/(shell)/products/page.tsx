import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { catalogStateFor } from '../../../src/catalog/catalog-states.tsx';
import { ProductsList } from '../../../src/catalog/products-list.tsx';
import type { CategoryTree, ListPagingMode } from '../../../src/catalog/products-list-types.ts';
import { EDIT_PERMISSION, type ProductOptions } from '../../../src/catalog/types.ts';
import { panelHostFor } from '../../../src/server/bff.ts';
import { catalogGate } from '../../../src/server/catalog-page.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.products.title') };
}

/**
 * The Products page: the list itself loads in the browser (it follows the address, which keeps the
 * view, search, filters, sort and page). The page reads what the list needs once: the category
 * tree, the Market's product types and the Market's "List paging" setting. A read that fails
 * only leaves its filter out, or pages with Previous and next.
 */
export default async function ProductsPage() {
  const t = await getTranslations();
  const title = t('catalog.products.title');
  const gate = await catalogGate();
  if (gate.kind !== 'ok') return catalogStateFor(gate, 's_products', title);
  const { session } = gate;
  const canEdit = session.permissionKeys.includes(EDIT_PERMISSION);
  const [tree, options, listPaging] = await Promise.all([
    serverGet<CategoryTree>('catalog/categories'),
    // The product types come with the form options, which need the edit key.
    canEdit
      ? serverGet<ProductOptions>('catalog/seller/products/options')
      : Promise.resolve(undefined),
    serverGet<{ readonly listPaging: string }>('settings/seller/list-paging'),
  ]);
  const paging: ListPagingMode =
    listPaging.kind === 'ok' && listPaging.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <SellerShell session={session} activeId="s_products" title={title}>
      <ProductsList
        accountId={session.accountId}
        marketId={marketId}
        timeZone={session.timezone}
        permissionKeys={session.permissionKeys}
        categories={tree.kind === 'ok' ? tree.body.categories : []}
        productTypes={options?.kind === 'ok' ? options.body.productTypes : []}
        paging={paging}
      />
    </SellerShell>
  );
}
