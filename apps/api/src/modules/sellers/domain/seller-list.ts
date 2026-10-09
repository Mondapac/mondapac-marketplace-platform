import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { sellerStatusOf, type AccessState, type SellerStatus } from './seller-status';
import { STORE_NAME_KEY_MAX_LENGTH, storeNameKey } from './store-name';

// The admin seller list (sellers design 7.8; slice 6): the request's shape, the keyset cursor
// and the one status a row shows. Pure rules; no Market, no I/O.

/** The tabs `sellers` serves from its own rows (design 7.8); the tabs of `identity` wait for R-6. */
export const LIST_TABS = ['awaiting-review', 'incomplete', 'all'] as const;
export type ListTab = (typeof LIST_TABS)[number];

/** The kinds of a pending submission (data design 3.2): a new application or a change request. */
export const LIST_KINDS = ['onboarding', 'identity-change'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export const LIST_DEFAULT_LIMIT = 25;
export const LIST_MAX_LIMIT = 50;
/** A search term is a prefix of at least this many characters, so it never names the whole Market. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;

/**
 * The search of a request (design 7.8): a prefix of the store-name key, and the same text as a
 * prefix of the shop slug when it has only slug characters. Never an identifier: a business
 * number is business data and its search waits for `sellers.business-details.view` (slice 7a-read).
 */
export interface ListSearch {
  readonly nameKey: string;
  readonly slug: string | null;
}

/** Where the previous page ended; it names the tab it belongs to. */
export type ListCursor =
  | { readonly tab: 'all'; readonly sellerId: Id<'Seller'> }
  | {
      readonly tab: 'incomplete';
      readonly changedAt: Temporal.Instant;
      readonly sellerId: Id<'Seller'>;
    }
  | {
      readonly tab: 'awaiting-review';
      readonly createdAt: Temporal.Instant;
      readonly revisionId: Id<'BusinessFileRevision'>;
    };

export interface ListRequest {
  readonly tab: ListTab;
  /** Awaiting review only; null for both kinds. */
  readonly kind: ListKind | null;
  /** Incomplete only: files whose saved address is outside every area that takes new sellers. */
  readonly outsideArea: boolean;
  readonly search: ListSearch | null;
  readonly after: ListCursor | null;
  readonly limit: number;
}

export interface ListFieldProblem {
  readonly path: string;
  readonly code: string;
}

export interface ListRequestRefused {
  readonly code: 'validation.failed';
  readonly fields: readonly ListFieldProblem[];
}

const KEYS = ['tab', 'kind', 'outsideArea', 'search', 'after', 'limit'] as const;
const MAX_ECHOED_UNKNOWN = 10;
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const SEARCH_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SLUG_CHARS = /^[a-z0-9-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text of a cursor: `all.<id>`, `incomplete.<epoch ms>.<id>`, `awaiting-review.<epoch ms>.<id>`. */
export function cursorText(cursor: ListCursor): string {
  switch (cursor.tab) {
    case 'all':
      return `all.${cursor.sellerId}`;
    case 'incomplete':
      return `incomplete.${cursor.changedAt.epochMilliseconds}.${cursor.sellerId}`;
    case 'awaiting-review':
      return `awaiting-review.${cursor.createdAt.epochMilliseconds}.${cursor.revisionId}`;
  }
}

/** The cursor of the text for this tab, or null: another tab's cursor and a malformed one alike. */
function parseCursor(text: string, tab: ListTab): ListCursor | null {
  const parts = text.split('.');
  if (parts[0] !== tab) return null;
  const idOf = <K extends string>(value: string | undefined): Id<K> | null => {
    const parsed = value === undefined ? null : parseId<K>(value);
    return parsed !== null && parsed.ok ? parsed.value : null;
  };
  if (tab === 'all') {
    const sellerId = parts.length === 2 ? idOf<'Seller'>(parts[1]) : null;
    return sellerId === null ? null : { tab, sellerId };
  }
  if (parts.length !== 3 || !/^\d{1,15}$/.test(parts[1]!)) return null;
  const instant = Temporal.Instant.fromEpochMilliseconds(Number(parts[1]));
  if (tab === 'incomplete') {
    const sellerId = idOf<'Seller'>(parts[2]);
    return sellerId === null ? null : { tab, changedAt: instant, sellerId };
  }
  const revisionId = idOf<'BusinessFileRevision'>(parts[2]);
  return revisionId === null ? null : { tab, createdAt: instant, revisionId };
}

function parseSearch(value: unknown, problems: ListFieldProblem[]): ListSearch | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    problems.push({ path: 'search', code: 'type' });
    return null;
  }
  if (SEARCH_FORBIDDEN.test(value)) {
    problems.push({ path: 'search', code: 'characters' });
    return null;
  }
  const key = storeNameKey(value);
  if (key === '') return null;
  const size = [...key].length;
  if (
    size < SEARCH_MIN_LENGTH ||
    size > SEARCH_MAX_LENGTH ||
    key.length > STORE_NAME_KEY_MAX_LENGTH
  ) {
    problems.push({ path: 'search', code: 'length' });
    return null;
  }
  return { nameKey: key, slug: SLUG_CHARS.test(key) ? key : null };
}

/**
 * Checks the shape of a list request: JSON object, a closed set of names, types, bounds, the
 * filter that belongs to each tab and the cursor of the tab. A problem is a path and a code; a
 * value is never echoed (design 8.3). The meaning of the values (does a seller match) is the
 * use case's.
 */
export function parseListRequest(raw: unknown): Result<ListRequest, ListRequestRefused> {
  if (raw === undefined) return parseListRequest({});
  if (!isRecord(raw)) {
    return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
  }
  const unknown = Object.keys(raw)
    .filter((key) => !(KEYS as readonly string[]).includes(key))
    .sort();
  if (unknown.length > 0) {
    const fields: ListFieldProblem[] = unknown.slice(0, MAX_ECHOED_UNKNOWN).map((key) => ({
      path: Array.from(key.replace(UNSAFE_NAME, '�')).slice(0, 64).join(''),
      code: 'unknown-field',
    }));
    if (unknown.length > MAX_ECHOED_UNKNOWN) fields.push({ path: '…', code: 'unknown-field' });
    return err({ code: 'validation.failed', fields });
  }

  const problems: ListFieldProblem[] = [];
  const get = (key: (typeof KEYS)[number]): unknown =>
    Object.hasOwn(raw, key) ? raw[key] : undefined;
  const present = (value: unknown): boolean => value !== undefined && value !== null;

  const tabValue = get('tab');
  let tab: ListTab = 'awaiting-review';
  if (present(tabValue)) {
    if (typeof tabValue !== 'string') problems.push({ path: 'tab', code: 'type' });
    else if (!(LIST_TABS as readonly string[]).includes(tabValue)) {
      problems.push({ path: 'tab', code: 'value' });
    } else tab = tabValue as ListTab;
  }

  const kindValue = get('kind');
  let kind: ListKind | null = null;
  if (present(kindValue)) {
    if (typeof kindValue !== 'string') problems.push({ path: 'kind', code: 'type' });
    else if (!(LIST_KINDS as readonly string[]).includes(kindValue)) {
      problems.push({ path: 'kind', code: 'value' });
    } else if (tab !== 'awaiting-review') problems.push({ path: 'kind', code: 'tab' });
    else kind = kindValue as ListKind;
  }

  const outsideValue = get('outsideArea');
  let outsideArea = false;
  if (present(outsideValue)) {
    if (typeof outsideValue !== 'boolean') problems.push({ path: 'outsideArea', code: 'type' });
    else if (outsideValue && tab !== 'incomplete')
      problems.push({ path: 'outsideArea', code: 'tab' });
    else outsideArea = outsideValue;
  }

  const limitValue = get('limit');
  let limit = LIST_DEFAULT_LIMIT;
  if (present(limitValue)) {
    if (typeof limitValue !== 'number') problems.push({ path: 'limit', code: 'type' });
    else if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > LIST_MAX_LIMIT) {
      problems.push({ path: 'limit', code: 'range' });
    } else limit = limitValue;
  }

  const search = parseSearch(get('search'), problems);

  const afterValue = get('after');
  let after: ListCursor | null = null;
  if (present(afterValue)) {
    if (typeof afterValue !== 'string') problems.push({ path: 'after', code: 'type' });
    else {
      after = parseCursor(afterValue, tab);
      if (after === null) problems.push({ path: 'after', code: 'format' });
    }
  }

  if (problems.length > 0) return err({ code: 'validation.failed', fields: problems });
  return ok({ tab, kind, outsideArea, search, after, limit });
}

/** The facts of one row that decide its status (design 3.3), all already read. */
export interface ListStatusInput {
  /** `identity`'s state, or null when `identity` does not know the seller. */
  readonly access: AccessState | null;
  readonly hasApprovedRevision: boolean;
  /** The kind of the seller's pending submission, or null when none is pending. */
  readonly pendingKind: ListKind | null;
  /** The file's own flag, written by the aggregate on every save (design 2.1). */
  readonly draftComplete: boolean;
  /** True when the saved address is outside every area that takes new sellers; null: no address. */
  readonly outsideServiceArea: boolean | null;
}

/**
 * The one status of design 3.3 a list row shows, or null when `identity` does not know the
 * seller (never a guess). The list does not decrypt the draft, so "what is missing" is the
 * file's own `draft_complete` flag: one placeholder part stands for "something is missing", and
 * only whether the list is empty matters to the status.
 */
export function listStatusOf(input: ListStatusInput): SellerStatus | null {
  if (input.access === null) return null;
  return sellerStatusOf({
    access: input.access,
    hasApprovedRevision: input.hasApprovedRevision,
    hasPendingOnboardingRevision: input.pendingKind === 'onboarding',
    missing: input.draftComplete ? [] : ['storeName'],
    outsideServiceArea: input.outsideServiceArea,
    registerNegative: false,
  });
}

/** At most this many sellers a search may name; more is `search.too-broad`, never a silent cut. */
export const SEARCH_CAP = 500;
