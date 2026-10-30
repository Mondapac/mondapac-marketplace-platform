// Pinned pages and recent pages (settings UX design, package S5). Identity stores only a time
// zone and a language per account, and a new field would need a schema change, so these two
// lists live in the browser's localStorage, keyed by panel, Market and account. They are a
// convenience: every read and write is guarded, and the panel works the same with storage missing
// (the lists then live for the page's lifetime only).

export const PIN_LIMIT = 5;
export const RECENT_LIMIT = 5;

export type PrefsKind = 'pins' | 'recent';

/** The storage key of one list of one account in one Market of one panel. */
export function prefsKey(
  panel: string,
  market: string,
  accountId: string,
  kind: PrefsKind,
): string {
  return `mp:${panel}:${market}:${accountId}:${kind}`;
}

export type PrefsStore = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's storage, or null when it is missing or refuses access (private window, blocked data). */
export function browserStorage(): PrefsStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The saved ids, or undefined when nothing usable is saved (so a caller falls back to defaults). */
export function readIds(store: PrefsStore | null, key: string): readonly string[] | undefined {
  try {
    const raw = store?.getItem(key) ?? null;
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return undefined;
    return value.filter((id): id is string => typeof id === 'string');
  } catch {
    return undefined;
  }
}

/** Saves the ids; false when storage is missing, full or refuses. The caller keeps its state either way. */
export function writeIds(store: PrefsStore | null, key: string, ids: readonly string[]): boolean {
  try {
    if (store === null) return false;
    store.setItem(key, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

export type PinChange =
  | { readonly kind: 'pinned' | 'unpinned'; readonly pins: readonly string[] }
  | { readonly kind: 'limit'; readonly pins: readonly string[] };

/** Pins the page, or unpins it when pinned. A sixth pin is refused and nothing changes. */
export function togglePin(pins: readonly string[], id: string, limit = PIN_LIMIT): PinChange {
  if (pins.includes(id)) return { kind: 'unpinned', pins: pins.filter((pin) => pin !== id) };
  if (pins.length >= limit) return { kind: 'limit', pins };
  return { kind: 'pinned', pins: [...pins, id] };
}

/** The page moves to the front of the recent list; the list keeps the last `limit` pages. */
export function pushRecent(
  recent: readonly string[],
  id: string,
  limit = RECENT_LIMIT,
): readonly string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, limit);
}

/**
 * The pins to show: the saved ones, or the defaults when nothing is saved. Ids of pages the
 * account can no longer open are dropped, duplicates collapse and the limit holds.
 */
export function resolvePins(
  saved: readonly string[] | undefined,
  defaults: readonly string[],
  validIds: ReadonlySet<string>,
  limit = PIN_LIMIT,
): readonly string[] {
  const source = saved ?? defaults;
  return [...new Set(source)].filter((id) => validIds.has(id)).slice(0, limit);
}

/**
 * The default pins of a role: the first `count` candidates (in the panel's priority order) that
 * the account may open. A role is its permission set, so the defaults follow from what is visible.
 */
export function defaultPins(
  candidates: readonly string[],
  validIds: ReadonlySet<string>,
  count = 3,
): readonly string[] {
  return [...new Set(candidates)].filter((id) => validIds.has(id)).slice(0, count);
}
