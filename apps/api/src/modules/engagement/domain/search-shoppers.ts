import type { Id } from '@mondapac/shared-kernel';

// Searchers per query (dashboards v2, phase 2: zero-result searches). For texts the storefront
// search found nothing for on a Market day (search's server-side note, handed over by reporting),
// engagement counts the distinct signed-in customers with personalization on who searched each
// text that day. Only a text searched by at least ten distinct customers is answered, with its
// counts; the account ids never leave this module and are never logged. Guests are never counted
// (a new guest cookie would be a new "person").

/** The fewest distinct searchers a text needs before it is answered at all (Hassan's rule). */
export const MIN_SEARCH_SHOPPERS = 10;
/** The most texts one request may name. */
export const MAX_SEARCH_KEYS = 2_000;
/** The longest text one request may name, in characters (search keeps at most 50). */
export const MAX_SEARCH_KEY_LENGTH = 200;
/** The most (text, account) pairs one window may have; beyond it the count is refused. */
export const MAX_SEARCH_PAIRS = 100_000;
/** The longest window one request may cover: a Market day of 25 hours, with a margin. */
export const MAX_SEARCH_WINDOW_HOURS = 26;

/** One stored search text of one account in the window, with how many events it has. */
export interface SearchPair {
  readonly query: string;
  readonly accountId: Id<'Account'>;
  readonly events: number;
}

/** A text searched by enough distinct customers: its key, searchers and searches. */
export interface SearchShoppers {
  readonly query: string;
  readonly shoppers: number;
  readonly searches: number;
}

/**
 * The key of a stored (already normalized) search text: lower case, locale-free, as search folds
 * the texts it notes.
 */
export function searchKeyOf(stored: string): string {
  return stored.normalize('NFC').toLowerCase();
}

/**
 * The asked keys searched by at least {@link MIN_SEARCH_SHOPPERS} distinct accounts, with their
 * searchers and searches (case variants of one text are one key), most searches first, then by
 * text. A text that was not asked is never answered.
 */
export function searchShoppersOf(
  pairs: readonly SearchPair[],
  keys: ReadonlySet<string>,
): SearchShoppers[] {
  const byKey = new Map<string, { accounts: Set<Id<'Account'>>; searches: number }>();
  for (const pair of pairs) {
    const key = searchKeyOf(pair.query);
    if (!keys.has(key)) continue;
    const entry = byKey.get(key) ?? { accounts: new Set<Id<'Account'>>(), searches: 0 };
    entry.accounts.add(pair.accountId);
    entry.searches += pair.events;
    byKey.set(key, entry);
  }
  return [...byKey]
    .filter(([, entry]) => entry.accounts.size >= MIN_SEARCH_SHOPPERS)
    .map(([query, entry]) => ({
      query,
      shoppers: entry.accounts.size,
      searches: entry.searches,
    }))
    .sort(
      (a, b) => b.searches - a.searches || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0),
    );
}
