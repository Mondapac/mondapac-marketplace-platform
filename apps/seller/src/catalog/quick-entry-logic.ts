import { minorOf } from '../price/money.ts';
import { stockKey, savedPriceText, savedStockText, type TableRow } from './variants-table-logic.ts';

/** At most this many new drafts share one quick entry table; the rest wait in Drafts. */
export const QUICK_MAX = 20;

/** One new draft in the quick entry table: its product and its sizes. */
export interface QuickGroup {
  readonly offerId: string;
  /** The product name, else its code. */
  readonly name: string;
  readonly productCode: string | null;
  /** The thumbnail address, else null (the package tile). */
  readonly thumb: string | null;
  readonly conditionCode: string;
  readonly handling: string | null;
  readonly rows: readonly TableRow[];
}

/** What a size still needs before it can go live, as the Status column says it. */
export type SizeStatus =
  | 'ready'
  | 'needs-price'
  | 'check-price'
  | 'needs-stock'
  | 'check-stock'
  | 'out-of-stock'
  | 'not-sold';

const WHOLE = /^\d{1,7}$/;

/**
 * The status of one size from what its cells show now (typed or saved): a price first, then
 * stock. Stock is only judged when the seller may see it (`sourceIds` not empty): none typed in
 * any location is "Needs stock", a total of 0 "Out of stock". A retired size is not sold.
 */
export function sizeStatusOf(
  row: TableRow,
  currency: string,
  sourceIds: readonly string[],
  priceDrafts: Readonly<Record<string, string>>,
  stockDrafts: Readonly<Record<string, string>>,
  showPrice = true,
): SizeStatus {
  if (row.price?.retired === true) return 'not-sold';
  if (showPrice) {
    const price = (priceDrafts[row.variantId] ?? savedPriceText(row, currency)).trim();
    if (price === '') return 'needs-price';
    if (minorOf(price, currency) === null) return 'check-price';
  }
  if (sourceIds.length === 0) return 'ready';
  const texts = sourceIds.map((sourceId) =>
    (stockDrafts[stockKey(row.variantId, sourceId)] ?? savedStockText(row, sourceId)).trim(),
  );
  if (texts.some((text) => text !== '' && !WHOLE.test(text))) return 'check-stock';
  if (texts.every((text) => text === '')) return 'needs-stock';
  const total = texts.reduce((sum, text) => sum + (text === '' ? 0 : Number(text)), 0);
  return total === 0 ? 'out-of-stock' : 'ready';
}

/** The ids of a quick entry address: UUIDs only, each once, at most `max`. */
export function quickIdsOf(value: string | string[] | undefined, max: number): string[] {
  const text = Array.isArray(value) ? value.join(',') : (value ?? '');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return [...new Set(text.split(',').filter((id) => uuid.test(id)))].slice(0, max);
}

/** The count of the `more` parameter: a whole number up to 10,000, else 0. */
export function moreOf(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  return /^\d{1,5}$/.test(text) ? Math.min(Number(text), 10_000) : 0;
}

/** `read` of every item, `size` items at a time, answers in the order of `items`. */
export async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(read))));
  }
  return out;
}
