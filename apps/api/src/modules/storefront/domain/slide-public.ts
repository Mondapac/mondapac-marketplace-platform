import { Temporal } from '@mondapac/shared-kernel';
import type { SlideScope } from './slide-positions';
import type { LinkType, SlideContent, SlideKind } from './slides';

// What the buyer site reads of the slide library: which live placements show on one page, in
// which order, and when the answer next changes. Pure functions; the use case supplies the facts.

/** A prepared search (a link of type `search`) is a code of this closed list, never a URL. */
export const PREPARED_SEARCHES: Readonly<Record<string, string>> = Object.freeze({
  specials: '/offers',
  express: '/express',
  certified: '/certified',
});

/** One projected placement of a live slide, with the slide facts the read needs. */
export interface ServedPlacement {
  /** The projection row's id: the last tie-break of which placement of a slide is served. */
  readonly placementId: string;
  readonly slideId: string;
  readonly kind: SlideKind;
  readonly liveVersionId: string;
  readonly scope: SlideScope;
  readonly scopeId: string | null;
  readonly includeSubcategories: boolean;
  readonly sortOrder: number;
  readonly autoplay: boolean;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly pinned: boolean;
  readonly sponsored: boolean;
}

/** The page the slider is asked for: the entity ids of the request, by scope. */
export interface PageScope {
  readonly category?: string;
  readonly product?: string;
  readonly seller?: string;
  readonly page?: string;
}

/**
 * Whether a placement's scope covers the page asked for. `all` always does; the others need the
 * request to name the same entity (a category also covers its subcategories when the placement
 * says so: `categoryChain` is the asked category and its ancestors).
 */
export function scopeCovers(
  placement: Pick<ServedPlacement, 'scope' | 'scopeId' | 'includeSubcategories'>,
  page: PageScope,
  categoryChain: readonly string[],
): boolean {
  switch (placement.scope) {
    case 'all':
      return true;
    case 'category':
      return placement.includeSubcategories
        ? placement.scopeId !== null && categoryChain.includes(placement.scopeId)
        : placement.scopeId !== null && placement.scopeId === page.category;
    case 'product':
      return placement.scopeId !== null && placement.scopeId === page.product;
    case 'seller':
      return placement.scopeId !== null && placement.scopeId === page.seller;
    case 'page':
      return placement.scopeId !== null && placement.scopeId === page.page;
  }
}

const isLive = (p: ServedPlacement, now: Temporal.Instant): boolean =>
  Temporal.Instant.compare(p.startsAt, now) <= 0 && Temporal.Instant.compare(now, p.endsAt) < 0;

/** The nearest start or end after `now` among the candidates; null when none is ahead. */
export function nextChange(
  candidates: readonly Pick<ServedPlacement, 'startsAt' | 'endsAt'>[],
  now: Temporal.Instant,
): Temporal.Instant | null {
  let next: Temporal.Instant | null = null;
  for (const c of candidates) {
    for (const t of [c.startsAt, c.endsAt]) {
      if (
        Temporal.Instant.compare(t, now) > 0 &&
        (next === null || Temporal.Instant.compare(t, next) < 0)
      ) {
        next = t;
      }
    }
  }
  return next;
}

/** How narrowly a placement is aimed: a named entity, then a category tree, then everywhere. */
const specificity = (p: Pick<ServedPlacement, 'scope' | 'includeSubcategories'>): number =>
  p.scope === 'all' ? 0 : p.scope === 'category' && p.includeSubcategories ? 1 : 2;

/**
 * Whether `a` is the placement of a slide to serve instead of `b`: the more specific scope, then
 * the smaller placement id. Never the sort order: a reorder must not change which placement (and
 * so which autoplay value) a page gets.
 */
const morePrecise = (a: ServedPlacement, b: ServedPlacement): boolean =>
  specificity(a) !== specificity(b)
    ? specificity(a) > specificity(b)
    : a.placementId < b.placementId;

/**
 * The placements to show now, one per slide (the best placement of a slide that matches twice),
 * pinned first, then by sort order, start time and id.
 */
export function showNow(
  placements: readonly ServedPlacement[],
  now: Temporal.Instant,
): ServedPlacement[] {
  const best = new Map<string, ServedPlacement>();
  for (const p of placements) {
    if (!isLive(p, now)) continue;
    const held = best.get(p.slideId);
    if (held === undefined || morePrecise(p, held)) best.set(p.slideId, p);
  }
  return [...best.values()].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      a.sortOrder - b.sortOrder ||
      Temporal.Instant.compare(a.startsAt, b.startsAt) ||
      (a.slideId < b.slideId ? -1 : a.slideId > b.slideId ? 1 : 0),
  );
}

/** A link target as a site path, or null when the target is dead. */
export interface LinkLookups {
  /** Live category id -> site path (`/c/<slug>[/<sub>...]`). */
  readonly categories: ReadonlyMap<string, string>;
  readonly products: ReadonlySet<string>;
  /** Selling seller id -> slug. */
  readonly sellers: ReadonlyMap<string, string>;
  /** Live landing page id -> slug. */
  readonly pages: ReadonlyMap<string, string>;
}

export function linkPath(
  link: NonNullable<SlideContent['link']>,
  lookups: LinkLookups,
): string | null {
  const type: LinkType = link.type;
  switch (type) {
    case 'category':
      return lookups.categories.get(link.id) ?? null;
    case 'product':
      return lookups.products.has(link.id) ? `/p/${link.id}` : null;
    case 'seller': {
      const slug = lookups.sellers.get(link.id);
      return slug === undefined ? null : `/s/${slug}`;
    }
    case 'page': {
      const slug = lookups.pages.get(link.id);
      return slug === undefined ? null : `/l/${slug}`;
    }
    case 'search':
      return PREPARED_SEARCHES[link.id] ?? null;
  }
}
