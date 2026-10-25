// The storefront slide library as the admin panel reads and writes it (apps/api storefront
// module: admin-slide.controller.ts, slide.dto.ts and domain/slides.ts, domain/slide-positions.ts).
// The permission keys, limits and closed lists of the screens live here, once.

export const SLIDE_READ_PERMISSION = 'storefront.slide.read';
export const SLIDE_EDIT_PERMISSION = 'storefront.slide.edit';
export const SLIDE_PUBLISH_PERMISSION = 'storefront.slide.publish';

export const SLIDES_API_PATH = 'storefront/admin/slides';
export const SLIDES_PATH = '/content/slides';
export const NEW_SLIDE_PATH = `${SLIDES_PATH}/new`;
/** The tab of one slide that holds its positions and window. */
export const placementPath = (slideId: string): string => `${SLIDES_PATH}/${slideId}/placement`;

export const SLIDE_KINDS = ['announcement', 'promotion', 'link'] as const;
export type SlideKind = (typeof SLIDE_KINDS)[number];

/** The status an admin sees (the API derives scheduled, live and ended from the window). */
export const SLIDE_STATUSES = [
  'live',
  'scheduled',
  'pending',
  'draft',
  'paused',
  'ended',
  'archived',
] as const;
export type SlideStatus = (typeof SLIDE_STATUSES)[number];

export const SLIDE_SCOPES = ['all', 'category', 'product', 'seller', 'page'] as const;
export type SlideScope = (typeof SLIDE_SCOPES)[number];

/**
 * The closed list of positions of the buyer site (apps/api storefront `slide-positions.ts`): the
 * most slides active at once, whether the position may move on its own, and the scopes a
 * placement there may have.
 */
export const SLIDE_POSITIONS: readonly {
  readonly key: string;
  readonly max: number;
  readonly autoplay: boolean;
  readonly scopes: readonly SlideScope[];
}[] = [
  { key: 'home.hero', max: 8, autoplay: true, scopes: ['all'] },
  { key: 'home.mid', max: 4, autoplay: false, scopes: ['all'] },
  { key: 'category.top', max: 4, autoplay: false, scopes: ['all', 'category'] },
  {
    key: 'product.below-details',
    max: 3,
    autoplay: false,
    scopes: ['all', 'category', 'product', 'seller'],
  },
  { key: 'cart.below-lines', max: 3, autoplay: false, scopes: ['all'] },
  { key: 'landing.top', max: 8, autoplay: true, scopes: ['all', 'page'] },
];

/** What a slide may open: a typed internal target, never a URL. */
export const LINK_TYPES = ['category', 'product', 'seller', 'page', 'search'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/**
 * The ready-made images of the buyer site (apps/web `/placeholders/<key>.jpg`) until the media
 * route exists. The API only checks the shape of a key, so this list is the panel's own mirror of
 * what the buyer site holds.
 */
export const IMAGE_KEYS = [
  'apple',
  'banana',
  'bread',
  'cheese',
  'chicken',
  'coconut',
  'egg',
  'fruits',
  'meat',
  'orange',
  'salmon',
  'watermelon',
] as const;

export const TITLE_MAX = 60;
export const BODY_MAX = 160;
export const CTA_MAX = 24;
export const NAME_MAX = 80;
export const ALT_MAX = 160;
/** A slide runs for at most 90 days (the API's rule). */
export const MAX_WINDOW_DAYS = 90;

/** A new slide is saved with this window and position; the "Where and when" tab changes them. */
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_POSITION = 'home.hero';

export interface SlideLink {
  readonly type: LinkType;
  readonly id: string;
}

export interface SlideImage {
  readonly ref: string;
  readonly alt: string;
  readonly decorative: boolean;
}

export interface SlideContent {
  readonly title: string;
  readonly body?: string;
  readonly ctaLabel?: string;
  readonly image?: SlideImage;
  readonly textPosition: 'start' | 'center' | 'end';
  readonly textTone: 'light' | 'dark';
  readonly link?: SlideLink;
}

export interface SlidePlacement {
  readonly position: string;
  readonly scope: SlideScope;
  readonly scopeId: string | null;
  readonly includeSubcategories: boolean;
  readonly sortOrder: number;
  readonly autoplay: boolean;
}

/** A row of `GET storefront/admin/slides`. */
export interface SlideSummary {
  readonly id: string;
  readonly kind: SlideKind;
  readonly internalName: string;
  readonly status: SlideStatus;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly hasDraft: boolean;
  readonly positions: readonly string[];
  readonly updatedAt: string;
}

export interface SlideList {
  readonly slides: readonly SlideSummary[];
}

export interface SlideVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly internalName: string;
  readonly content: SlideContent | null;
  readonly placements: readonly SlidePlacement[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly createdAt: string;
  readonly approvedAt: string | null;
}

/** `GET storefront/admin/slides/:id` and the answer of create and update. */
export interface SlideDetail extends SlideSummary {
  readonly draft: SlideVersion | null;
  readonly live: SlideVersion | null;
  readonly pending: boolean;
  readonly versions: readonly {
    readonly id: string;
    readonly versionNo: number;
    readonly createdAt: string;
    readonly approvedAt: string | null;
  }[];
}

/** Live and scheduled first, then waiting, drafts, paused, ended, archived (the handoff's order). */
const ORDER: Record<SlideStatus, number> = {
  live: 0,
  scheduled: 1,
  pending: 2,
  draft: 3,
  paused: 4,
  ended: 5,
  archived: 6,
};

/** Soonest start first among live and scheduled slides; the most recently changed first elsewhere. */
export function sortSlides(slides: readonly SlideSummary[]): SlideSummary[] {
  return [...slides].sort((a, b) => {
    const group = (ORDER[a.status] ?? 99) - (ORDER[b.status] ?? 99);
    if (group !== 0) return group;
    if (a.status === 'live' || a.status === 'scheduled') {
      return a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);
    }
    return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
  });
}

export const isKnownStatus = (value: string): value is SlideStatus =>
  (SLIDE_STATUSES as readonly string[]).includes(value);

export const isKnownKind = (value: string): value is SlideKind =>
  (SLIDE_KINDS as readonly string[]).includes(value);

/** The status chip and button a row or the editor header shows depend on these. */
export function canReview(permissionKeys: readonly string[], status: SlideStatus): boolean {
  return status === 'pending' && permissionKeys.includes(SLIDE_PUBLISH_PERMISSION);
}
