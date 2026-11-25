import type { VariantPrice } from '../price/types.ts';
import type { StockCell, StockLevelsView } from '../stock/levels-types.ts';
import {
  stockKey,
  writesOf,
  type Invalid,
  type TableRow,
  type Write,
} from './variants-table-logic.ts';

// The pure half of editing prices and stock right in the Offer list (Offer page PR 8, design
// section 7): what one page of Offers reads, which cells a row can edit, and what a save sends.

/** `GET pricing/seller/offer-prices`: the prices of the own Offers of one page. */
export interface OffersPricesAnswer {
  readonly currency: string;
  readonly offers: readonly {
    readonly offerId: string;
    readonly variants: readonly VariantPrice[];
  }[];
}

/** `GET inventory/seller/offer-stock`: the stock of the own Offers of one page. */
export interface OffersStockAnswer {
  readonly offers: readonly StockLevelsView[];
}

/** One Offer of the list as the inline cells see it. */
export interface InlineOffer {
  readonly offerId: string;
  /** Its sizes: price and stock as read; `label` is empty until the size names are read. */
  readonly rows: readonly TableRow[];
  /** The seller's stock locations, in their order; empty when stock is not shown. */
  readonly sourceIds: readonly string[];
  /** The prices were read: when that read failed, the price cells show a dash, not a field. */
  readonly priced: boolean;
}

/**
 * The Offers of one page from the two reads (either may be null: the seller may not see it, or it
 * failed). The sizes are those the stock read lists (the sell units of the Offer), else those the
 * price read lists. An Offer that neither read answered is absent: the row shows no cell to edit.
 */
export function inlineOffersOf(
  prices: OffersPricesAnswer | null,
  stock: OffersStockAnswer | null,
): Map<string, InlineOffer> {
  const out = new Map<string, InlineOffer>();
  const priceOf = new Map(prices?.offers.map((offer) => [offer.offerId, offer.variants]) ?? []);
  const stockOf = new Map(stock?.offers.map((offer) => [offer.offerId, offer.variants]) ?? []);
  const ids = [...new Set([...stockOf.keys(), ...priceOf.keys()])];
  for (const offerId of ids) {
    const priced = priceOf.get(offerId) ?? [];
    const stocked = stockOf.get(offerId);
    // The stock read lists the sizes still sold; the price read also keeps retired ones.
    const variantIds =
      stocked !== undefined
        ? stocked.map((variant) => variant.variantId)
        : priced.filter((variant) => !variant.retired).map((variant) => variant.variantId);
    const rows: TableRow[] = variantIds.map((variantId) => {
      const cells: readonly StockCell[] =
        stocked?.find((variant) => variant.variantId === variantId)?.sources ?? [];
      return {
        variantId,
        label: '',
        price: priced.find((variant) => variant.variantId === variantId) ?? null,
        stock: Object.fromEntries(cells.map((cell) => [cell.sourceId, cell])),
      };
    });
    const sourceIds = stocked?.[0]?.sources.map((cell) => cell.sourceId) ?? [];
    out.set(offerId, { offerId, rows, sourceIds, priced: prices !== null });
  }
  return out;
}

/** The cells a collapsed row edits in place: one size, and for stock one location. */
export interface RowEditing {
  readonly price: boolean;
  readonly stock: boolean;
  /** The row has more than its cells can hold: several sizes or several locations. */
  readonly opens: 'sizes' | 'locations' | null;
}

export function rowEditing(offer: InlineOffer): RowEditing {
  const single = offer.rows.length === 1 && offer.rows[0]?.price?.retired !== true;
  const opens =
    offer.rows.length > 1 ? 'sizes' : single && offer.sourceIds.length > 1 ? 'locations' : null;
  return {
    price: single && offer.priced,
    stock: single && offer.sourceIds.length === 1,
    opens,
  };
}

/** The lowest and the highest regular price in force of the sizes; null when none has one. */
export function priceRange(
  rows: readonly TableRow[],
): { readonly min: string; readonly max: string } | null {
  const amounts = rows.flatMap((row) =>
    row.price?.retired === true || row.price?.inForce == null
      ? []
      : [BigInt(row.price.inForce.amount)],
  );
  if (amounts.length === 0) return null;
  const min = amounts.reduce((a, b) => (b < a ? b : a));
  const max = amounts.reduce((a, b) => (b > a ? b : a));
  return { min: min.toString(), max: max.toString() };
}

/** The units on hand over every size and location; null when no stock cell was read. */
export function stockTotal(rows: readonly TableRow[]): number | null {
  const cells = rows.flatMap((row) =>
    row.price?.retired === true
      ? []
      : Object.values(row.stock).filter((cell) => cell !== undefined),
  );
  return cells.length === 0 ? null : cells.reduce((sum, cell) => sum + (cell?.onHand ?? 0), 0);
}

/** The typed values of the page, per Offer: price by variant id, stock by `variant:source`. */
export type Drafts = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** What a save of the list sends: per Offer, its writes and its fields that are not valid. */
export interface OfferPlan {
  readonly offer: InlineOffer;
  readonly writes: readonly Write[];
  readonly invalid: readonly Invalid[];
}

export function plansOf(
  offers: ReadonlyMap<string, InlineOffer>,
  currency: string,
  priceDrafts: Drafts,
  stockDrafts: Drafts,
): OfferPlan[] {
  const ids = [...new Set([...Object.keys(priceDrafts), ...Object.keys(stockDrafts)])];
  return ids.flatMap((offerId) => {
    const offer = offers.get(offerId);
    if (offer === undefined) return [];
    const plan = writesOf(
      offer.rows,
      offer.sourceIds.map((id) => ({ id })),
      currency,
      priceDrafts[offerId] ?? {},
      stockDrafts[offerId] ?? {},
    );
    return plan.writes.length + plan.invalid.length === 0 ? [] : [{ offer, ...plan }];
  });
}

/** One change of the save bar's line: the size, and the old and the new value. */
export interface ChangeLine {
  readonly offerId: string;
  readonly variantId: string;
  readonly kind: 'price' | 'stock';
  /** Minor units for a price, units for stock; null where nothing was saved before. */
  readonly from: string | null;
  readonly to: string;
}

/** The writes of the plans as old and new values, in the order they are sent. */
export function changeLines(plans: readonly OfferPlan[]): ChangeLine[] {
  return plans.flatMap((plan) =>
    plan.writes.map((write): ChangeLine => {
      const row = plan.offer.rows.find((item) => item.variantId === write.variantId);
      return write.kind === 'price'
        ? {
            offerId: plan.offer.offerId,
            variantId: write.variantId,
            kind: 'price',
            from: row?.price?.inForce?.amount ?? null,
            to: write.amount,
          }
        : {
            offerId: plan.offer.offerId,
            variantId: write.variantId,
            kind: 'stock',
            from:
              row?.stock[write.sourceId]?.version == null
                ? null
                : String(row.stock[write.sourceId]?.onHand ?? 0),
            to: String(write.onHand),
          };
    }),
  );
}

/** The drafts of one Offer with one value set (an empty map stays out of the page's drafts). */
export function withDraft(drafts: Drafts, offerId: string, key: string, value: string): Drafts {
  return { ...drafts, [offerId]: { ...(drafts[offerId] ?? {}), [key]: value } };
}

/** The drafts left after a save: a saved cell goes, unless it was typed again meanwhile. */
export function withoutSaved(
  drafts: Drafts,
  saved: Readonly<Record<string, readonly string[]>>,
  sent: Drafts,
): Drafts {
  const next: Record<string, Record<string, string>> = {};
  for (const [offerId, values] of Object.entries(drafts)) {
    const left = { ...values };
    for (const key of saved[offerId] ?? []) {
      if (left[key] === sent[offerId]?.[key]) delete left[key];
    }
    if (Object.keys(left).length > 0) next[offerId] = left;
  }
  return next;
}

/** The read version of each typed cell, per Offer, keyed as `sendSizeWrites` keys its versions. */
export type Bases = Readonly<Record<string, Readonly<Record<string, number | null>>>>;

/**
 * The base versions left after a save: a cell whose draft went keeps none; a cell still typed
 * keeps its version, or the one its write answered when it was saved and typed again meanwhile.
 */
export function basesAfterSave(
  bases: Bases,
  seen: Readonly<Record<string, Readonly<Record<string, number | null>>>>,
  priceDrafts: Drafts,
  stockDrafts: Drafts,
): Bases {
  const next: Record<string, Record<string, number | null>> = {};
  for (const [offerId, keys] of Object.entries(bases)) {
    const kept: Record<string, number | null> = {};
    for (const [key, version] of Object.entries(keys)) {
      const [kind, cell] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const drafted =
        kind === 'price'
          ? priceDrafts[offerId]?.[cell] !== undefined
          : stockDrafts[offerId]?.[cell] !== undefined;
      if (!drafted) continue;
      const answered = seen[offerId];
      kept[key] = answered !== undefined && key in answered ? (answered[key] ?? null) : version;
    }
    if (Object.keys(kept).length > 0) next[offerId] = kept;
  }
  return next;
}

export { stockKey };
