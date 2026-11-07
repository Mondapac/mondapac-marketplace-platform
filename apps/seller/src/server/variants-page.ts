import 'server-only';
import { redirect } from 'next/navigation';
import { axesOf, combinationTitle } from '../catalog/variant-grid.ts';
import { variantRowsOf } from '../catalog/draft-content.ts';
import { VIEW_PERMISSION, type OfferView, type ProductView } from '../catalog/types.ts';
import type { TableRow } from '../catalog/variants-table-logic.ts';
import { fileModelOf } from '../catalog/variant-file-model.ts';
import type { FileModel } from '../catalog/variant-file.ts';
import {
  PRICE_EDIT_PERMISSION,
  PRICE_VIEW_PERMISSION,
  type OfferPricesView,
} from '../price/types.ts';
import { SETUP_ROOT } from '../setup/steps.ts';
import { STOCK_EDIT_PERMISSION, type StockLevelsView } from '../stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
import { serverGet } from './server-fetch.ts';
import { requireSession, type SellerSession } from './session.ts';

export type VariantsPage =
  | {
      readonly kind: 'ok';
      readonly session: SellerSession;
      readonly offer: OfferView;
      /** The Market currency of the prices; null when the seller may not see prices. */
      readonly currency: string | null;
      readonly rows: readonly TableRow[];
      readonly sources: SourcesView['sources'];
      /** What the variant file reads and writes; null without the key to read the product. */
      readonly fileModel: FileModel | null;
    }
  | { readonly kind: 'no-access'; readonly session: SellerSession }
  | { readonly kind: 'not-found'; readonly session: SellerSession }
  | { readonly kind: 'unavailable' };

/**
 * The session, the offer and, for what the seller may see, its prices and stock levels, joined per
 * variant for the offer's variants table. The variant names come from the product's draft when the
 * seller may read it; otherwise a row is named by its position.
 */
export async function loadVariantsPage(
  offerId: string,
  locale: string,
  fallbackName: (number: number) => string,
): Promise<VariantsPage> {
  const gate = await requireSession();
  if (gate.kind === 'unavailable') return { kind: 'unavailable' };
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const keys = session.permissionKeys;
  const canPrice = keys.includes(PRICE_VIEW_PERMISSION);
  const canStock = keys.includes(STOCK_VIEW_PERMISSION);
  if (!canPrice && !canStock) return { kind: 'no-access', session };

  const offer = await serverGet<OfferView>(`catalog/seller/offers/${offerId}`);
  if (offer.kind === 'signed-out') redirect('/session-ended');
  if (offer.kind === 'not-found') return { kind: 'not-found', session };
  if (offer.kind !== 'ok') return { kind: 'unavailable' };
  const [prices, stock, sources, product] = await Promise.all([
    canPrice
      ? serverGet<OfferPricesView>(`pricing/seller/offers/${offerId}/prices`)
      : Promise.resolve(null),
    canStock
      ? serverGet<StockLevelsView>(`inventory/seller/offers/${offerId}/stock`)
      : Promise.resolve(null),
    canStock ? serverGet<SourcesView>('inventory/seller/sources') : Promise.resolve(null),
    keys.includes(VIEW_PERMISSION)
      ? serverGet<ProductView>(`catalog/seller/products/${offer.body.productId}`)
      : Promise.resolve(null),
  ]);
  const reads = [prices, stock, sources];
  if (reads.some((item) => item?.kind === 'signed-out')) redirect('/session-ended');
  if (reads.some((item) => item?.kind === 'not-found')) return { kind: 'not-found', session };
  if (reads.some((item) => item !== null && item.kind !== 'ok')) return { kind: 'unavailable' };
  const priceBody = prices?.kind === 'ok' ? prices.body : null;
  const stockBody = stock?.kind === 'ok' ? stock.body : null;

  const ids = [
    ...(priceBody?.variants.map((variant) => variant.variantId) ?? []),
    ...(stockBody?.variants.map((variant) => variant.variantId) ?? []),
  ].filter((id, index, all) => all.indexOf(id) === index);

  // A name per variant from the product's draft options; "Variant n" when they cannot be read.
  const names = new Map<string, string>();
  if (product?.kind === 'ok') {
    const view = product.body;
    const content = view.workingCopy?.content;
    const draftRows = variantRowsOf(content, view.variants);
    const axes = axesOf(content, draftRows, view.form.fields);
    for (const row of draftRows) {
      const title = combinationTitle(view.form.fields, axes, row.options, locale);
      if (title !== '' && row.variantId !== null) names.set(row.variantId, title);
    }
  }
  const rows: TableRow[] = ids.map((id, index) => ({
    variantId: id,
    label: names.get(id) ?? fallbackName(index + 1),
    price: priceBody?.variants.find((variant) => variant.variantId === id) ?? null,
    stock: Object.fromEntries(
      (stockBody?.variants.find((variant) => variant.variantId === id)?.sources ?? []).map(
        (cell) => [cell.sourceId, cell],
      ),
    ),
  }));
  const sourceList = sources?.kind === 'ok' ? sources.body.sources : [];
  return {
    kind: 'ok',
    session,
    offer: offer.body,
    currency: priceBody?.currency ?? null,
    rows,
    sources: sourceList,
    fileModel:
      product?.kind === 'ok'
        ? fileModelOf({
            product: product.body,
            rows,
            sources: sourceList,
            currency: priceBody?.currency ?? null,
            locale,
            canEditPrice: keys.includes(PRICE_EDIT_PERMISSION),
            canEditStock: keys.includes(STOCK_EDIT_PERMISSION),
          })
        : null,
  };
}
