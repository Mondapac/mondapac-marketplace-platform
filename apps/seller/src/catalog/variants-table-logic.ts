import { inputOf, minorOf } from '../price/money.ts';
import { instantOfZoned } from '../price/zone-time.ts';
import type { VariantPrice } from '../price/types.ts';
import type { StockCell } from '../stock/levels-types.ts';
import type { SellUnitView } from './types.ts';

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
  /** The variant's sell unit (SKU and Selling); null or missing when the page did not read one. */
  readonly unit?: SellUnitView | null;
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
/** A new special price for one size (Offer page PR 6): it replaces any running or scheduled one. */
export interface SpecialWrite {
  readonly kind: 'special';
  readonly variantId: string;
  readonly amount: string;
  /** UTC instant; null starts it now. */
  readonly startsAt: string | null;
  readonly endsAt: string;
}
export type Write = PriceWrite | StockWrite | SpecialWrite;

/** A line a save cannot send because its text is not a valid value. */
export interface Invalid {
  readonly key: string;
  readonly kind: 'price' | 'stock' | 'special-amount' | 'special-start' | 'special-end';
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
      // "10" for a saved "10.00" is the same price: nothing to send.
      else if (String(amount) !== String(row.price?.inForce?.amount ?? ''))
        writes.push({ kind: 'price', variantId: row.variantId, amount });
    }
    for (const source of sources) {
      const key = stockKey(row.variantId, source.id);
      const draft = stockDrafts[key];
      if (draft === undefined || draft.trim() === savedStockText(row, source.id)) continue;
      const onHand = WHOLE.test(draft.trim()) ? Number(draft) : null;
      if (onHand === null || onHand > 1_000_000) invalid.push({ key, kind: 'stock' });
      else if (onHand !== row.stock[source.id]?.onHand)
        writes.push({ kind: 'stock', variantId: row.variantId, sourceId: source.id, onHand });
    }
  }
  return { writes, invalid };
}

/** The special price fields of one size as typed in its Details (Offer page PR 6). */
export interface SpecialDraft {
  readonly amount: string;
  /** `datetime-local` text in the seller's zone; empty starts it now. */
  readonly start: string;
  /** `datetime-local` text in the seller's zone; required. */
  readonly end: string;
}

export const EMPTY_SPECIAL: SpecialDraft = { amount: '', start: '', end: '' };

/** The error keys of a size's special fields: under the amount, the start and the end. */
export const specialKey = {
  amount: (variantId: string): string => `special:${variantId}`,
  start: (variantId: string): string => `special-start:${variantId}`,
  end: (variantId: string): string => `special-end:${variantId}`,
} as const;

/** Whether the seller typed anything in a size's special fields. */
export function isSpecialTyped(draft: SpecialDraft | undefined): draft is SpecialDraft {
  return (
    draft !== undefined &&
    (draft.amount.trim() !== '' || draft.start.trim() !== '' || draft.end.trim() !== '')
  );
}

/**
 * The special price writes a save sends, read from the Details fields: a size with any field
 * typed sends one write, or one `invalid` line per field that is wrong (the amount is not money,
 * the start is not a time, the end is missing or not a time). Times are read in the seller's zone.
 * The server checks the rest (below the regular price, the end after the start, not in the past).
 */
export function specialWritesOf(
  rows: readonly TableRow[],
  currency: string,
  zone: string,
  drafts: Readonly<Record<string, SpecialDraft>>,
): { readonly writes: SpecialWrite[]; readonly invalid: Invalid[] } {
  const writes: SpecialWrite[] = [];
  const invalid: Invalid[] = [];
  for (const row of rows) {
    if (row.price?.retired === true) continue;
    const draft = drafts[row.variantId];
    if (!isSpecialTyped(draft)) continue;
    const amount = minorOf(draft.amount, currency);
    const startsAt = draft.start.trim() === '' ? null : instantOfZoned(draft.start, zone);
    const endsAt = instantOfZoned(draft.end, zone);
    const bad: Invalid[] = [];
    if (amount === null)
      bad.push({ key: specialKey.amount(row.variantId), kind: 'special-amount' });
    if (draft.start.trim() !== '' && startsAt === null)
      bad.push({ key: specialKey.start(row.variantId), kind: 'special-start' });
    if (endsAt === null) bad.push({ key: specialKey.end(row.variantId), kind: 'special-end' });
    if (bad.length > 0 || amount === null || endsAt === null) {
      invalid.push(...bad);
      continue;
    }
    writes.push({ kind: 'special', variantId: row.variantId, amount, startsAt, endsAt });
  }
  return { writes, invalid };
}

/**
 * The order a save sends its writes in. A special goes after the regular price of its size,
 * because it must stay below the new regular price; but when the new regular price is at or below
 * the running or scheduled special, the special goes first, as the server refuses a regular price
 * that is not above a special.
 */
export function orderedWrites(
  rows: readonly TableRow[],
  writes: readonly Write[],
  specials: readonly SpecialWrite[],
): Write[] {
  const first: Write[] = [];
  const last: Write[] = [];
  for (const special of specials) {
    const row = rows.find((item) => item.variantId === special.variantId);
    const price = writes.find(
      (write): write is PriceWrite =>
        write.kind === 'price' && write.variantId === special.variantId,
    );
    const current = row?.price?.special?.amount;
    const lowersBelow =
      price !== undefined && current !== undefined && BigInt(price.amount) <= BigInt(current);
    (lowersBelow ? first : last).push(special);
  }
  return [...first, ...writes, ...last];
}
