// The storefront pages as the admin panel reads and writes them (apps/api storefront module:
// admin-storefront.controller.ts, storefront.dto.ts and domain/templates.ts, page-settings.ts).
// The permission keys, limits and closed lists of the Pages screens live here, once.

export const PAGE_READ_PERMISSION = 'storefront.page.read';
export const PAGE_EDIT_PERMISSION = 'storefront.page.edit';
export const PAGE_CREATE_PERMISSION = 'storefront.page.create';
/** Protected keys: only a platform administrator holds them. */
export const PAGE_PUBLISH_PERMISSION = 'storefront.page.publish';
export const PAGE_ARCHIVE_PERMISSION = 'storefront.page.archive';

export const PAGES_API_PATH = 'storefront/admin/pages';
export const CATALOGUE_API_PATH = 'storefront/admin/catalogue';
export const PAGES_PATH = '/content';
export const NEW_PAGE_PATH = '/content/pages/new';
export const pagePath = (page: string): string => `/content/pages/${page}`;

export const TITLE_MAX = 120;
export const SLUG_MAX = 80;
/** A dynamic page is served at `/l/<slug>`. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The templates an admin may create a page from (storefront `DYNAMIC_TEMPLATE_KEYS`). */
export const DYNAMIC_TEMPLATES = [
  'campaign-landing',
  'brand-page',
  'product-spotlight',
  'info-page',
] as const;
export type DynamicTemplate = (typeof DYNAMIC_TEMPLATES)[number];

export const PAGE_STATUSES = [
  'default',
  'draft',
  'scheduled',
  'published',
  'ended',
  'archived',
] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export const EDIT_LEVELS = ['full', 'limited', 'locked', 'navigation'] as const;
export type EditLevel = (typeof EDIT_LEVELS)[number];

export const isKnownStatus = (value: string): value is PageStatus =>
  (PAGE_STATUSES as readonly string[]).includes(value);
export const isKnownEditLevel = (value: string): value is EditLevel =>
  (EDIT_LEVELS as readonly string[]).includes(value);
export const isKnownTemplate = (value: string): value is DynamicTemplate =>
  (DYNAMIC_TEMPLATES as readonly string[]).includes(value);

export interface PageSummary {
  readonly id: string | null;
  readonly kind: string;
  readonly systemKey: string | null;
  readonly slug: string | null;
  readonly path: string;
  readonly templateKey: string;
  readonly title: string;
  readonly editLevel: string;
  readonly status: string;
  readonly hasDraft: boolean;
  readonly publishedVersionNo: number | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
}

export interface PageList {
  readonly pages: readonly PageSummary[];
}

export interface CatalogueTemplate {
  readonly key: string;
  readonly scope: string;
  readonly linkable: readonly string[];
}

export interface Catalogue {
  readonly templates: readonly CatalogueTemplate[];
}

/** The page's own key in the editor URL: its id, or the key of an unchanged system page. */
export const pageRef = (page: PageSummary): string | null => page.id ?? page.systemKey;

/** The navigation is edited on its own tab, so it is not a row of the list. */
export const listedPages = (pages: readonly PageSummary[]): readonly PageSummary[] =>
  pages.filter((page) => page.editLevel !== 'navigation' && page.systemKey !== 'navigation');

// The page editor: one page as `GET storefront/admin/pages/:page` answers it (storefront.dto.ts
// `PageDetailBody`), and the routes of its draft changes.

export interface SlotDefinition {
  readonly key: string;
  /** `fixed`: the app fills it (a listing, the results); nothing is added there. */
  readonly kind: string;
  readonly modules: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly width: string;
}

export interface Placement {
  readonly id: string;
  readonly module: string;
  readonly enabled: boolean;
  /** The module's settings: plain data, never markup (storefront `parseModuleConfig`). */
  readonly config: Readonly<Record<string, unknown>>;
}
export type Placements = Readonly<Record<string, readonly Placement[]>>;

export interface Seo {
  readonly title?: string;
  readonly description?: string;
  readonly image?: { readonly ref: string; readonly alt: string };
}

export interface PendingSettings {
  readonly title: string;
  readonly slug?: string;
  readonly seo: Seo;
  readonly linked?: { readonly type: string; readonly id: string } | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

export interface PageDetail extends PageSummary {
  readonly seo: Seo;
  readonly linked: { readonly type: string; readonly id: string } | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly archivedRedirect: string | null;
  readonly slots: readonly SlotDefinition[];
  readonly draft: {
    readonly versionNo: number | null;
    readonly placements: Placements;
    /** What publishing puts on the page; null: the page's own settings stay. */
    readonly settings: PendingSettings | null;
    readonly updatedAt: string | null;
  };
  readonly published: { readonly versionNo: number; readonly placements: Placements } | null;
  readonly versions: readonly PageVersion[];
}

export const VERSION_STATES = ['draft', 'published', 'retired'] as const;

export interface PageVersion {
  readonly id: string;
  readonly versionNo: number;
  /** `draft`, `published` (what buyers see) or `retired` (earlier published versions). */
  readonly state: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

/** The key the editor URL and the draft routes name the page by. */
export const detailRef = (page: PageDetail): string => page.id ?? page.systemKey ?? '';

export const settingsPagePath = (page: string): string => `${pagePath(page)}/settings`;
export const slotModulesPath = (page: string, slot: string): string =>
  `${PAGES_API_PATH}/${encodeURIComponent(page)}/slots/${encodeURIComponent(slot)}/modules`;
export const modulePath = (page: string, slot: string, placement: string): string =>
  `${slotModulesPath(page, slot)}/${encodeURIComponent(placement)}`;
export const slotOrderPath = (page: string, slot: string): string =>
  `${PAGES_API_PATH}/${encodeURIComponent(page)}/slots/${encodeURIComponent(slot)}/order`;
export const pageApiPath = (page: string): string =>
  `${PAGES_API_PATH}/${encodeURIComponent(page)}`;

export const PAGE_EDIT_LEVEL_LOCKED = 'locked';
/** A page that takes no change: locked in the app, archived, or no edit permission. */
export const isReadOnlyPage = (page: PageSummary, canEdit: boolean): boolean =>
  !canEdit || page.status === 'archived' || page.editLevel === 'locked';

export const versionsPagePath = (page: string): string => `${pagePath(page)}/versions`;
export const restorePath = (page: string): string => `${pageApiPath(page)}/restore`;
export const publishPath = (page: string): string => `${pageApiPath(page)}/publish`;
export const archivePath = (page: string): string => `${pageApiPath(page)}/archive`;
