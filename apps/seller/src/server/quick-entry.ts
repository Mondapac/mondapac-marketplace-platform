import 'server-only';
import { redirect } from 'next/navigation';
import { productThumbSrc } from '../catalog/product-thumb.ts';
import { inBatches, type QuickGroup } from '../catalog/quick-entry-logic.ts';
import type { OfferSellUnitsView, OfferView } from '../catalog/types.ts';
import { PRICE_VIEW_PERMISSION, type OfferPricesView } from '../price/types.ts';
import type { StockLevelsView } from '../stock/levels-types.ts';
import { STOCK_VIEW_PERMISSION, type SourcesView } from '../stock/types.ts';
import { serverGet } from './server-fetch.ts';

/** How many drafts are read at the same time (four reads each). */
const OFFERS_AT_ONCE = 4;

/** What the quick entry table of new drafts needs (Offer page PR 5). */
export interface QuickEntry {
  readonly groups: readonly QuickGroup[];
  /** How many of the asked drafts could not be read (deleted, another seller's, or failed). */
  readonly unreadable: number;
  /** The Market currency of the prices; null when the seller may not see prices. */
  readonly currency: string | null;
  readonly sources: SourcesView['sources'];
  /** The seller may see stock but the locations could not be read: no stock column is shown. */
  readonly stockUnavailable: boolean;
}

/**
 * Reads each draft (the gate: the catalog view key, checked by the page), with its prices, stock
 * levels and sell units as far as `permissionKeys` may see them, and the stock locations once. A
 * draft that cannot be read is counted, not shown; a signed-out read goes to the session-ended
 * page. Sizes are named by their published label, else "Size n".
 */
export async function loadQuickEntry(
  offerIds: readonly string[],
  permissionKeys: readonly string[],
  marketId: string,
  fallbackName: (number: number) => string,
): Promise<QuickEntry> {
  const canPrice = permissionKeys.includes(PRICE_VIEW_PERMISSION);
  const canStock = permissionKeys.includes(STOCK_VIEW_PERMISSION);
  const readOffer = (offerId: string) =>
    Promise.all([
      serverGet<OfferView>(`catalog/seller/offers/${offerId}`),
      serverGet<OfferSellUnitsView>(`catalog/seller/offers/${offerId}/sell-units`),
      canPrice
        ? serverGet<OfferPricesView>(`pricing/seller/offers/${offerId}/prices`)
        : Promise.resolve(null),
      canStock
        ? serverGet<StockLevelsView>(`inventory/seller/offers/${offerId}/stock`)
        : Promise.resolve(null),
    ]);
  // A few drafts at a time, so one page load never sends all its reads at once.
  const [sources, reads] = await Promise.all([
    canStock ? serverGet<SourcesView>('inventory/seller/sources') : Promise.resolve(null),
    inBatches(offerIds, OFFERS_AT_ONCE, readOffer),
  ]);
  const all = [sources, ...reads.flat()];
  if (all.some((item) => item?.kind === 'signed-out')) redirect('/session-ended');
  let currency: string | null = null;
  let unreadable = 0;
  const groups: QuickGroup[] = [];
  for (const [offer, units, prices, stock] of reads) {
    if (
      offer.kind !== 'ok' ||
      units.kind !== 'ok' ||
      (prices !== null && prices.kind !== 'ok') ||
      (stock !== null && stock.kind !== 'ok')
    ) {
      unreadable += 1;
      continue;
    }
    const priceBody = prices?.kind === 'ok' ? prices.body : null;
    const stockBody = stock?.kind === 'ok' ? stock.body : null;
    currency ??= priceBody?.currency ?? null;
    const view = offer.body;
    groups.push({
      offerId: view.offerId,
      name: view.product.name ?? view.product.productCode ?? view.sellerSku,
      productCode: view.product.productCode,
      thumb: productThumbSrc(marketId, { productId: view.productId, ...view.product }),
      conditionCode: view.conditionCode,
      handling: view.handling,
      // Only the sizes the seller sells: one switched off needs no price or stock here.
      rows: units.body.units
        .filter((unit) => unit.selling)
        .map((unit, index) => ({
          variantId: unit.variantId,
          label: unit.label ?? fallbackName(index + 1),
          unit,
          price: priceBody?.variants.find((item) => item.variantId === unit.variantId) ?? null,
          stock: Object.fromEntries(
            (
              stockBody?.variants.find((item) => item.variantId === unit.variantId)?.sources ?? []
            ).map((cell) => [cell.sourceId, cell]),
          ),
        })),
    });
  }
  return {
    groups,
    unreadable,
    currency,
    sources: sources?.kind === 'ok' ? sources.body.sources : [],
    stockUnavailable: sources !== null && sources.kind !== 'ok',
  };
}
