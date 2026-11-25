import 'server-only';
import { redirect } from 'next/navigation';
import { axesOf, combinationTitle } from '../catalog/variant-grid.ts';
import { variantRowsOf } from '../catalog/draft-content.ts';
import {
  EDIT_PERMISSION,
  VIEW_PERMISSION,
  type OfferSellUnitsView,
  type OfferView,
  type ProductView,
} from '../catalog/types.ts';
import {
  requestAxesOf,
  type SizeRequestsData,
  type SizeRequestsView,
} from '../catalog/size-request-logic.ts';
import { fileModelOf } from '../catalog/variant-file-model.ts';
import type { FileModel } from '../catalog/variant-file.ts';
import type { TableRow } from '../catalog/variants-table-logic.ts';
import {
  PRICE_EDIT_PERMISSION,
  PRICE_VIEW_PERMISSION,
  type OfferPricesView,
} from '../price/types.ts';
import { STOCK_EDIT_PERMISSION, type StockLevelsView } from '../stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
import { serverGet } from './server-fetch.ts';

/** What the offer's sizes table needs: its rows, locations, units, size requests and file. */
export interface OfferSizes {
  /** The Market currency of the prices; null when the seller may not see prices. */
  readonly currency: string | null;
  readonly rows: readonly TableRow[];
  readonly sources: SourcesView['sources'];
  /** The SKU and Selling columns (variants V5); null when the seller may not view the catalog. */
  readonly units: {
    readonly productScope: 'PLATFORM' | 'SELLER';
    readonly sellerSku: string;
  } | null;
  /** Request a size and the seller's requests (variants V7); null when the product cannot take any. */
  readonly sizeRequests: SizeRequestsData | null;
  /** What the variant file reads and writes; null without the key to read the product. */
  readonly fileModel: FileModel | null;
}

/**
 * For the one-page offer (Offer page PR 3), after the offer itself was read: its prices, stock
 * levels and sell units, as far as `permissionKeys` may see them, joined per variant. The variant
 * names are the published label of the unit, else come from the product's draft when the seller
 * may read it; otherwise a row is named by its position. `unavailable` when one of those reads
 * fails: the page then shows the offer and says only the sizes could not be read. A signed-out
 * read goes to the session-ended page.
 */
export async function loadOfferSizes(
  offer: OfferView,
  permissionKeys: readonly string[],
  locale: string,
  fallbackName: (number: number) => string,
): Promise<OfferSizes | 'unavailable'> {
  const keys = permissionKeys;
  const offerId = offer.offerId;
  const canPrice = keys.includes(PRICE_VIEW_PERMISSION);
  const canStock = keys.includes(STOCK_VIEW_PERMISSION);
  const canUnits = keys.includes(VIEW_PERMISSION);
  const [prices, stock, sources, product, units, requests] = await Promise.all([
    canPrice
      ? serverGet<OfferPricesView>(`pricing/seller/offers/${offerId}/prices`)
      : Promise.resolve(null),
    canStock
      ? serverGet<StockLevelsView>(`inventory/seller/offers/${offerId}/stock`)
      : Promise.resolve(null),
    canStock ? serverGet<SourcesView>('inventory/seller/sources') : Promise.resolve(null),
    canUnits
      ? serverGet<ProductView>(`catalog/seller/products/${offer.productId}`)
      : Promise.resolve(null),
    canUnits
      ? serverGet<OfferSellUnitsView>(`catalog/seller/offers/${offerId}/sell-units`)
      : Promise.resolve(null),
    // The list is a courtesy: when it cannot be read the page still works without it.
    canUnits
      ? serverGet<SizeRequestsView>('catalog/seller/variant-requests?limit=50')
      : Promise.resolve(null),
  ]);
  const reads = [prices, stock, sources, units];
  if (requests?.kind === 'signed-out') redirect('/session-ended');
  if (reads.some((item) => item?.kind === 'signed-out')) redirect('/session-ended');
  if (reads.some((item) => item !== null && item.kind !== 'ok')) return 'unavailable';
  const priceBody = prices?.kind === 'ok' ? prices.body : null;
  const stockBody = stock?.kind === 'ok' ? stock.body : null;

  const unitsBody = units?.kind === 'ok' ? units.body : null;
  const unitOf = new Map(unitsBody?.units.map((unit) => [unit.variantId, unit] as const) ?? []);

  const ids = [
    ...(unitsBody?.units.map((unit) => unit.variantId) ?? []),
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
    label: unitOf.get(id)?.label ?? names.get(id) ?? fallbackName(index + 1),
    unit: unitOf.get(id) ?? null,
    price: priceBody?.variants.find((variant) => variant.variantId === id) ?? null,
    stock: Object.fromEntries(
      (stockBody?.variants.find((variant) => variant.variantId === id)?.sources ?? []).map(
        (cell) => [cell.sourceId, cell],
      ),
    ),
  }));
  const sourceList = sources?.kind === 'ok' ? sources.body.sources : [];
  return {
    currency: priceBody?.currency ?? null,
    rows,
    sources: sourceList,
    units:
      unitsBody === null
        ? null
        : { productScope: unitsBody.productScope, sellerSku: unitsBody.sellerSku },
    sizeRequests: sizeRequestsOf(unitsBody?.productScope, product, requests, offerId, locale),
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
            canEditSellUnits: keys.includes(EDIT_PERMISSION),
          })
        : null,
  };
}

/** The "Request a size" data of a PLATFORM product with axes, else null. */
function sizeRequestsOf(
  scope: 'PLATFORM' | 'SELLER' | undefined,
  product: Awaited<ReturnType<typeof serverGet<ProductView>>> | null,
  requests: Awaited<ReturnType<typeof serverGet<SizeRequestsView>>> | null,
  offerId: string,
  locale: string,
): SizeRequestsData | null {
  if (scope !== 'PLATFORM' || product?.kind !== 'ok' || requests?.kind !== 'ok') return null;
  const axes = requestAxesOf(product.body, locale);
  if (axes.length === 0) return null;
  return {
    axes,
    items: requests.body.items.filter((item) => item.offerId === offerId),
    openCount: requests.body.openCount,
    maxOpen: requests.body.maxOpen,
  };
}
