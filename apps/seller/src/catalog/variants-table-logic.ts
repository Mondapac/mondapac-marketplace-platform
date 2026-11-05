import { inputOf, minorOf } from '../price/money.ts';
import type { VariantPrice } from '../price/types.ts';
import type { StockCell } from '../stock/levels-types.ts';

// The pure half of the offer's variants table (variants V3b): the draft values of a bulk action
// and the writes a save has to send. Money stays in minor units as exact integers.

/** A percent with at most two decimals, from 0.01 up to 1000: "10", "2.5". */
const PERCENT = /^(\d{1,4})(?:\.(\d{1,2}))?$/;

/**
 * `amount` (minor units, text) raised by `percent` ("10" is ten percent), rounded half up to a
 * whole minor unit; null when the percent is not valid or the result is not a positive amount.
 */
export function increasedBy(amount: string, percent: string): string | null {
  const match = PERCENT.exec(percent.trim());
  if (match === null || !/^\d{1,13}$/.test(amount)) return null;
  const hundredths = BigInt(`${match[1] as string}${(match[2] ?? '').padEnd(2, '0')}`);
  if (hundredths === 0n || hundredths > 100_000n) return null;
  const scaled = BigInt(amount) * (10_000n + hundredths);
  const result = (scaled + 5_000n) / 10_000n;
  return result > 0n && result.toString().length <= 13 ? result.toString() : null;
}

/** One variant's line in the table: its labels, price and stock as the page loaded them. */
export interface TableRow {
  readonly variantId: string;
  readonly label: string;
  readonly price: VariantPrice | null;
  /** Stock cell per location id. */
  readonly stock: Readonly<Record<string, StockCell | undefined>>;
}

export const stockKey = (variantId: string, sourceId: string): string => `${variantId}:${sourceId}`;

/** The price field's text as saved: the price in force in major units, or empty. */
export function savedPriceText(row: TableRow, currency: string): string {
  return row.price?.inForce == null ? '' : inputOf(row.price.inForce.amount, currency);
}

export function savedStockText(row: TableRow, sourceId: string): string {
  const cell = row.stock[sourceId];
  return cell === undefined ? '' : String(cell.onHand);
}

export interface PriceWrite {
  readonly kind: 'price';
  readonly variantId: string;
  readonly amount: string;
}
export interface StockWrite {
  readonly kind: 'stock';
  readonly variantId: string;
  readonly sourceId: string;
  readonly onHand: number;
}
export type Write = PriceWrite | StockWrite;

/** A line a save cannot send because its text is not a valid value. */
export interface Invalid {
  readonly key: string;
  readonly kind: 'price' | 'stock';
}

const WHOLE = /^\d{1,7}$/;

/**
 * The writes a save sends: a price or stock cell whose draft differs from what was saved. A
 * retired variant and a cell without a draft are skipped; an empty or invalid draft is returned
 * in `invalid` and nothing is sent for it.
 */
export function writesOf(
  rows: readonly TableRow[],
  sources: readonly { readonly id: string }[],
  currency: string,
  priceDrafts: Readonly<Record<string, string>>,
  stockDrafts: Readonly<Record<string, string>>,
): { readonly writes: Write[]; readonly invalid: Invalid[] } {
  const writes: Write[] = [];
  const invalid: Invalid[] = [];
  for (const row of rows) {
    if (row.price?.retired === true) continue;
    const price = priceDrafts[row.variantId];
    if (price !== undefined && price.trim() !== savedPriceText(row, currency)) {
      const amount = minorOf(price, currency);
      if (amount === null) invalid.push({ key: row.variantId, kind: 'price' });
      else writes.push({ kind: 'price', variantId: row.variantId, amount });
    }
    for (const source of sources) {
      const key = stockKey(row.variantId, source.id);
      const draft = stockDrafts[key];
      if (draft === undefined || draft.trim() === savedStockText(row, source.id)) continue;
      const onHand = WHOLE.test(draft.trim()) ? Number(draft) : null;
      if (onHand === null || onHand > 1_000_000) invalid.push({ key, kind: 'stock' });
      else writes.push({ kind: 'stock', variantId: row.variantId, sourceId: source.id, onHand });
    }
  }
  return { writes, invalid };
}
