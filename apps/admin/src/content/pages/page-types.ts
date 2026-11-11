// The storefront pages as the admin panel reads and writes them (apps/api storefront module:
// admin-storefront.controller.ts, storefront.dto.ts and domain/templates.ts, page-settings.ts).
// The permission keys, limits and closed lists of the Pages screens live here, once.

export const PAGE_READ_PERMISSION = 'storefront.page.read';
export const PAGE_EDIT_PERMISSION = 'storefront.page.edit';
export const PAGE_CREATE_PERMISSION = 'storefront.page.create';

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
