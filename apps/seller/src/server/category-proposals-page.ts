import 'server-only';
import { redirect } from 'next/navigation';
import {
  PROPOSE_PERMISSION,
  type CategoryLocales,
  type OwnProposals,
  type ParentCategory,
} from '../categories/types.ts';
import { EDIT_PERMISSION, type ProductOptions, type ProductView } from '../catalog/types.ts';
import type { ProductsPage } from '../catalog/products-list-types.ts';
import { catalogGate, type CatalogPage } from './catalog-page.ts';
import { serverGet } from './server-fetch.ts';

export interface ProposalsPageData {
  readonly proposals: OwnProposals;
  readonly parents: readonly ParentCategory[];
  readonly locales: CategoryLocales;
}

/**
 * The Suggest a category page's reads. The platform categories a shelf may sit under are only
 * served inside a product read (`form.categories`), so they come from the seller's newest product;
 * a seller with no product yet gets an empty list (the page says so).
 */
export async function loadProposalsPage(): Promise<CatalogPage<ProposalsPageData>> {
  const gate = await catalogGate(PROPOSE_PERMISSION);
  if (gate.kind !== 'ok') return gate;
  const { session } = gate;
  const own = await serverGet<OwnProposals>('catalog/seller/category-proposals');
  if (own.kind === 'signed-out') redirect('/session-ended');
  if (own.kind === 'forbidden') return { kind: 'no-access', session };
  if (own.kind !== 'ok') return { kind: 'unavailable' };
  let locales: CategoryLocales = { default: 'en-AU', supported: ['en-AU'] };
  const options = session.permissionKeys.includes(EDIT_PERMISSION)
    ? await serverGet<ProductOptions>('catalog/seller/products/options')
    : null;
  if (options?.kind === 'ok') locales = options.body.locales;
  let parents: readonly ParentCategory[] = [];
  const list = await serverGet<ProductsPage>(
    'catalog/seller/products?pageSize=25&sort=updated&direction=desc',
  );
  const first = list.kind === 'ok' ? list.body.items[0] : undefined;
  if (first !== undefined) {
    const product = await serverGet<ProductView>(`catalog/seller/products/${first.productId}`);
    if (product.kind === 'ok') parents = product.body.form.categories;
  }
  return { kind: 'ok', session, body: { proposals: own.body, parents, locales } };
}

/** The seller's active shelves for an Offer page; none when the read is refused or fails. */
export async function loadActiveShelves(
  permissionKeys: readonly string[],
  defaultLocale: string,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  if (!permissionKeys.includes(PROPOSE_PERMISSION)) return [];
  const own = await serverGet<OwnProposals>('catalog/seller/category-proposals');
  if (own.kind !== 'ok') return [];
  return own.body.shelves
    .filter((shelf) => shelf.status === 'active')
    .map((shelf) => ({
      id: shelf.id,
      name:
        (shelf.texts.find((text) => text.locale === defaultLocale) ?? shelf.texts[0])?.name ??
        shelf.slug,
    }));
}
