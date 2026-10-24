import type { Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { StoreImageRef } from './store-image';

/**
 * What `sellers` holds in clear about a store with an approved revision and a held slug, for the
 * buyer site's store pages (slice 12, sellers design 7.1 `publishedStoreProfile`). Clear columns
 * only: no key is unwrapped, so no personal field (business name, phone, contact email, address
 * lines, postcode, identifier) can reach the answer (AC 25).
 */
export interface ApprovedStoreFacts {
  readonly sellerId: Id<'Seller'>;
  /** The held slug of the seller, never a retired one. */
  readonly slug: string;
  /** `public_store_name`: the approved revision's store name. */
  readonly name: string;
  /** The ServiceArea code of the approved revision's operating address (clear). */
  readonly serviceAreaCode: string;
  /** The approved revision's IANA zone; the "selling since" year is read in it. */
  readonly operatingTimezone: string;
  /** When the seller's first revision was approved. */
  readonly firstApprovedAt: Temporal.Instant;
}

/**
 * One store as the public read answers it: an allow-list, nothing else (AC 25). `minimumOrder` is
 * `null` for "no minimum" and absent when it cannot be told (a stored currency that is not the
 * Market's): the buyer site then shows no minimum line rather than a wrong one.
 */
export interface PublishedStore {
  readonly slug: string;
  readonly name: string;
  readonly serviceAreaCode: string;
  /** The calendar year of the first approval, in the seller's own zone (ADR-0005). */
  readonly sellingSince: number;
  readonly minimumOrder?: Money | null;
  /**
   * The About text in the Market's default locale (slice 12 part 2): a store page only, `null`
   * when the store wrote none, plain text that is never HTML. Absent on the list.
   */
  readonly about?: string | null;
  /** The current logo (a store page and the list) and banner (a store page only); `null`: none. */
  readonly logo?: StoreImageRef | null;
  readonly banner?: StoreImageRef | null;
}

/** The orders of the public store list. */
export const PUBLISHED_STORE_SORTS = ['name', 'newest'] as const;
export type PublishedStoreSort = (typeof PUBLISHED_STORE_SORTS)[number];

/** The year of the first approval in the seller's zone; the UTC year when the zone is not valid. */
export function sellingSinceOf(facts: ApprovedStoreFacts): number {
  try {
    return facts.firstApprovedAt.toZonedDateTimeISO(facts.operatingTimezone).year;
  } catch {
    return facts.firstApprovedAt.toZonedDateTimeISO('UTC').year;
  }
}

const byName = new Intl.Collator('und', { sensitivity: 'base', numeric: true });

/**
 * Sorts stores for the list: `name` by the name (locale-neutral, case and accent folded), then
 * slug; `newest` by first approval, latest first, then slug. The slug is unique in the Market, so
 * the order is total and pages are stable.
 */
export function sortStores(
  stores: readonly ApprovedStoreFacts[],
  sort: PublishedStoreSort,
): ApprovedStoreFacts[] {
  const bySlug = (a: ApprovedStoreFacts, b: ApprovedStoreFacts): number =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  return [...stores].sort((a, b) => {
    if (sort === 'newest') {
      const order = b.firstApprovedAt.epochMilliseconds - a.firstApprovedAt.epochMilliseconds;
      return order !== 0 ? Math.sign(order) : bySlug(a, b);
    }
    return byName.compare(a.name, b.name) || bySlug(a, b);
  });
}
