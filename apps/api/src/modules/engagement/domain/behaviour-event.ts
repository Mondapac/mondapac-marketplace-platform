import { parseId } from '@mondapac/shared-kernel';
import type { Id, Temporal } from '@mondapac/shared-kernel';

// Shopping behaviour (personalization package 1a; owner decisions 4 and 5 of 2026-10-18). What a
// shopper looked at, searched for or put in the cart, held by ids only, to feed the
// recommendations of package 1d. Kept 12 months for a signed-in customer and 30 days for a guest
// (own guest token, like the guest cart); no third-party pixel; the customer can switch it off.
// Nothing here infers religion or diet: an event is an id, never a reading of the shopper.

/** The kinds of behaviour recorded. */
export const BEHAVIOUR_KINDS = [
  'product-viewed',
  'category-viewed',
  'search-performed',
  'added-to-cart',
] as const;
export type BehaviourKind = (typeof BEHAVIOUR_KINDS)[number];

/** The longest search text kept, in characters after normalization. */
export const MAX_SEARCH_QUERY_LENGTH = 200;

/** How long a signed-in customer's behaviour is kept (owner decision 4). */
export const ACCOUNT_RETENTION = { months: 12 } as const;
/** How long a guest's behaviour is kept, and the life of the guest token (owner decision 4). */
export const GUEST_RETENTION = { days: 30 } as const;

/** One event as recorded: the kind and the ids (or search text) that kind carries. */
export type BehaviourFacts =
  | {
      readonly kind: 'product-viewed';
      readonly productId: Id<'Product'>;
      readonly offerId: Id<'Offer'> | null;
    }
  | { readonly kind: 'category-viewed'; readonly categoryId: Id<'Category'> }
  | { readonly kind: 'search-performed'; readonly query: string }
  | {
      readonly kind: 'added-to-cart';
      readonly offerId: Id<'Offer'>;
      readonly variantId: Id<'Variant'>;
    };

/** The fields each kind requires and allows; any other field is refused. */
const FIELDS: Readonly<
  Record<BehaviourKind, { readonly required: readonly string[]; readonly optional: string[] }>
> = {
  'product-viewed': { required: ['productId'], optional: ['offerId'] },
  'category-viewed': { required: ['categoryId'], optional: [] },
  'search-performed': { required: ['query'], optional: [] },
  'added-to-cart': { required: ['offerId', 'variantId'], optional: [] },
};

/** Every field an event body may name. */
export const BEHAVIOUR_FIELDS: readonly string[] = [
  'kind',
  'productId',
  'offerId',
  'variantId',
  'categoryId',
  'query',
];

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/**
 * The search text as kept: Unicode NFC, control characters removed, runs of white space made one
 * space, trimmed. Empty means there is no text.
 */
export function normalizeSearchQuery(text: string): string {
  return text.normalize('NFC').replace(/\p{C}/gu, ' ').replace(/\s+/gu, ' ').trim();
}

const isBehaviourKind = (value: unknown): value is BehaviourKind =>
  typeof value === 'string' && (BEHAVIOUR_KINDS as readonly string[]).includes(value);

/**
 * Reads an event body into its facts, or lists every problem: the kind is required and one of
 * {@link BEHAVIOUR_KINDS}; each kind's required fields are present (ids as canonical UUIDv7, the
 * search text 1 to 200 characters after normalization); a field another kind uses is refused.
 */
export function readBehaviour(
  input: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly facts: BehaviourFacts }
  | { readonly ok: false; readonly fields: FieldProblem[] } {
  const kind = input?.kind;
  if (kind === undefined) return { ok: false, fields: [{ path: 'kind', code: 'required' }] };
  if (!isBehaviourKind(kind)) return { ok: false, fields: [{ path: 'kind', code: 'one-of' }] };

  const fields: FieldProblem[] = [];
  const { required, optional } = FIELDS[kind];
  for (const name of BEHAVIOUR_FIELDS) {
    if (name === 'kind' || input[name] === undefined) continue;
    if (!required.includes(name) && !optional.includes(name)) {
      fields.push({ path: name, code: 'not-allowed' });
    }
  }
  const id = <K extends string>(name: string, need: boolean): Id<K> | null => {
    const value = input[name];
    if (value === undefined || value === null) {
      if (need) fields.push({ path: name, code: 'required' });
      return null;
    }
    const parsed = parseId<K>(value as string);
    if (!parsed.ok) {
      fields.push({ path: name, code: 'format' });
      return null;
    }
    return parsed.value;
  };

  switch (kind) {
    case 'product-viewed': {
      const productId = id<'Product'>('productId', true);
      const offerId = id<'Offer'>('offerId', false);
      if (fields.length > 0 || productId === null) return { ok: false, fields };
      return { ok: true, facts: { kind, productId, offerId } };
    }
    case 'category-viewed': {
      const categoryId = id<'Category'>('categoryId', true);
      if (fields.length > 0 || categoryId === null) return { ok: false, fields };
      return { ok: true, facts: { kind, categoryId } };
    }
    case 'search-performed': {
      const raw = input.query;
      let query = '';
      if (raw === undefined || raw === null) fields.push({ path: 'query', code: 'required' });
      else if (typeof raw !== 'string') fields.push({ path: 'query', code: 'type' });
      else {
        query = normalizeSearchQuery(raw);
        if (query.length === 0) fields.push({ path: 'query', code: 'required' });
        else if (Array.from(query).length > MAX_SEARCH_QUERY_LENGTH) {
          fields.push({ path: 'query', code: 'too-long' });
        }
      }
      if (fields.length > 0) return { ok: false, fields };
      return { ok: true, facts: { kind, query } };
    }
    case 'added-to-cart': {
      const offerId = id<'Offer'>('offerId', true);
      const variantId = id<'Variant'>('variantId', true);
      if (fields.length > 0 || offerId === null || variantId === null) return { ok: false, fields };
      return { ok: true, facts: { kind, offerId, variantId } };
    }
  }
}

/**
 * The retention edges at `now`: a signed-in customer's events before `account` and a guest's
 * before `guest` are past their retention. Months are counted on the UTC calendar.
 */
export function retentionEdges(now: Temporal.Instant): {
  readonly account: Temporal.Instant;
  readonly guest: Temporal.Instant;
} {
  return {
    account: now.toZonedDateTimeISO('UTC').subtract(ACCOUNT_RETENTION).toInstant(),
    guest: now.toZonedDateTimeISO('UTC').subtract(GUEST_RETENTION).toInstant(),
  };
}
