import { Temporal } from '@mondapac/shared-kernel';
import type { SearchQuery } from './search-query';

// Zero-result searches (dashboards v2, phase 2). The storefront search notes, on the server, the
// text of a plain text search whose first page found nothing, so the admin dashboard can list what
// shoppers look for and cannot find. Only the folded text and the quarter hour are kept: no
// session, account, guest, IP address or device. Text that may name or reach a person is not kept
// at all, and nothing is shown on the dashboard unless ten distinct signed-in shoppers searched it
// on one Market day (engagement counts them; reporting keeps only those).

/** The longest text kept, in characters after folding: longer text reads as a sentence. */
export const MAX_ZERO_RESULT_KEY_LENGTH = 50;
/** The shortest text kept, like the search route's own minimum. */
export const MIN_ZERO_RESULT_KEY_LENGTH = 2;
/** At five digits or more a text may be a phone, order or card number (or a GTIN). */
export const MAX_ZERO_RESULT_DIGITS = 4;
/** The width of a bucket: every zone offset in use is a whole number of quarter hours. */
export const ZERO_RESULT_BUCKET_MINUTES = 15;
/** How long a noted text is kept: the snapshot's 28-day look-back with a margin. */
export const ZERO_RESULT_RETENTION_DAYS = 35;

/**
 * The text as kept and matched: Unicode NFC, control characters made spaces, white space runs
 * made one space, trimmed, lower case (`toLowerCase`, locale-free). The same folding engagement
 * applies to its search events, so one query has one key. Null when it should not be kept: empty
 * or shorter than {@link MIN_ZERO_RESULT_KEY_LENGTH}, longer than {@link MAX_ZERO_RESULT_KEY_LENGTH},
 * an e-mail address or a web address, or more than {@link MAX_ZERO_RESULT_DIGITS} digits in all.
 */
export function zeroResultKeyOf(text: string): string | null {
  const key = text
    .normalize('NFC')
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  const length = Array.from(key).length;
  if (length < MIN_ZERO_RESULT_KEY_LENGTH || length > MAX_ZERO_RESULT_KEY_LENGTH) return null;
  if (key.includes('@') || key.includes('://') || key.includes('www.')) return null;
  if ((key.match(/\p{Nd}/gu) ?? []).length > MAX_ZERO_RESULT_DIGITS) return null;
  return key;
}

/**
 * Whether a checked request and its page are a zero-result search: a text search with nothing
 * else narrowing it (no category, store, brand, attribute filter or price), on page 1, that shows
 * no item and no next page. A browse, a later page or a filtered list is never one.
 */
export function isZeroResultSearch(
  query: SearchQuery,
  page: { readonly items: number; readonly hasMore: boolean },
): boolean {
  return (
    query.text !== null &&
    query.categoryId === null &&
    query.storeSlug === null &&
    query.brandSlug === null &&
    query.filters.choices.length === 0 &&
    query.filters.ranges.length === 0 &&
    query.price === null &&
    query.page === 1 &&
    page.items === 0 &&
    !page.hasMore
  );
}

/** The start of the UTC quarter hour of an instant (floored, also before 1970). */
export function zeroResultBucketOf(at: Temporal.Instant): Temporal.Instant {
  const width = BigInt(ZERO_RESULT_BUCKET_MINUTES * 60) * 1_000_000_000n;
  const ns = at.epochNanoseconds;
  const floored = ns - (((ns % width) + width) % width);
  return Temporal.Instant.fromEpochNanoseconds(floored);
}
