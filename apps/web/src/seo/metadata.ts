import 'server-only';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { activeFilterCount, type ListingState } from '../catalog/listing-state.ts';
import { sellerFilterCount, type SellersState } from '../sellers/sellers-state.ts';
import { storefrontApiConfig, storefrontHostFor } from '../storefront/config.ts';
import {
  DEFAULT_IMAGE,
  DESCRIPTION_KEYS,
  cutDescription,
  cutTitle,
  pageTitle,
  type DescriptionKey,
} from './defaults.ts';
import { indexingOn } from './indexing.ts';

/** What a page tells search engines and link previews about itself (SEO plan, package 1). */
export interface PageSeo {
  /** The page's own name; absent on the home page, whose title is the store title alone. */
  readonly name?: string;
  /** Already filled from page data; cut to the description length here. */
  readonly description: string;
  /**
   * The canonical path: the current path with the query that names the page (the search words)
   * and nothing else. Filters and sort never belong here.
   */
  readonly path: string;
  /** A listing's page; page 1 has no `page` parameter. */
  readonly page?: number;
  /** Keep the page out of the index; its links are still followed. */
  readonly noindex?: boolean;
  /** The page's own image: a site path or an https URL. */
  readonly image?: string;
}

/** Fills a description template of `seo.descriptions`; `{store}` is the store title. */
export async function seoDescription(
  key: DescriptionKey,
  values: Record<string, string> = {},
): Promise<string> {
  const [store, t] = await Promise.all([
    getTranslations('store'),
    getTranslations('seo.descriptions'),
  ]);
  return t(DESCRIPTION_KEYS[key], { ...values, store: store('title') });
}

/** Any filter or an order other than the default makes a listing a copy of its plain page. */
export function listingNoindex(state: ListingState): boolean {
  return activeFilterCount(state.filters) > 0 || state.sort !== 'recommended';
}

export function sellersNoindex(state: SellersState): boolean {
  return sellerFilterCount(state.filters) > 0 || state.sort !== 'popular';
}

/** The origin of the listed host the request came to; none on sample data or an unknown host. */
export async function requestOrigin(): Promise<string | undefined> {
  const config = storefrontApiConfig();
  if (config === null) return undefined;
  return storefrontHostFor(config, (await headers()).get('host'))?.origin;
}

/**
 * Only a path on this site or an https URL; anything else (a logo key, another scheme) is no
 * image. A path is checked after parsing, since the parser reads `\` as `/` and drops tabs and
 * newlines (`/\evil.example` would leave the site).
 */
export function imageUrl(value: string | undefined, origin: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.startsWith('/')) {
      const url = new URL(value, origin);
      return url.origin === origin ? url.href : undefined;
    }
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute canonical, or none when parsing changed the path: a `.` or `..` segment from a
 * path param would collapse into another page's address.
 */
export function canonicalOf(
  seo: Pick<PageSeo, 'path' | 'page'>,
  origin: string,
): string | undefined {
  const url = new URL(seo.path, origin);
  if (url.origin !== origin || url.pathname !== seo.path.split('?', 1)[0]) return undefined;
  if (seo.page !== undefined && seo.page > 1) url.searchParams.set('page', String(seo.page));
  return url.href;
}

/**
 * The page-level robots rule. Next takes a page's robots instead of the layout's, so the root
 * rule is repeated here: while indexing is off every page is `noindex, nofollow`.
 */
function robotsOf(noindex: boolean): Pick<Metadata, 'robots'> {
  if (!indexingOn()) return { robots: { index: false, follow: false } };
  return noindex ? { robots: { index: false, follow: true } } : {};
}

/** The robots rule alone, for a layout whose every page stays out of the index. */
export function noindexMetadata(): Metadata {
  return robotsOf(true);
}

type AccountPage = 'overview' | 'orders' | 'addresses' | 'lists' | 'settings' | 'delete';

/** An account page's head tags: its menu title and description; never indexed. */
export async function accountMetadata(page: AccountPage, path: string): Promise<Metadata> {
  const [t, description] = await Promise.all([
    getTranslations('account.titles'),
    seoDescription(`account-${page}`),
  ]);
  return pageMetadata({ name: t(page), description, path, noindex: true });
}

/** The Metadata of a buyer-site page; every page builds its head tags here. */
export async function pageMetadata(seo: PageSeo): Promise<Metadata> {
  const [store, origin] = await Promise.all([getTranslations('store'), requestOrigin()]);
  const storeTitle = store('title');
  const title = seo.name === undefined ? storeTitle : pageTitle(cutTitle(seo.name), storeTitle);
  const description = cutDescription(seo.description);
  const robots = robotsOf(seo.noindex === true);
  // Without a known host there is no absolute URL to give, so no canonical, og:url or image.
  if (origin === undefined) {
    return {
      title: { absolute: title },
      description,
      ...robots,
      openGraph: { type: 'website', siteName: storeTitle, title, description },
      twitter: { card: 'summary', title, description },
    };
  }
  const canonical = canonicalOf(seo, origin);
  const image = imageUrl(seo.image ?? DEFAULT_IMAGE, origin);
  return {
    metadataBase: new URL(origin),
    title: { absolute: title },
    description,
    ...(canonical === undefined ? {} : { alternates: { canonical } }),
    ...robots,
    openGraph: {
      type: 'website',
      siteName: storeTitle,
      title,
      description,
      ...(canonical === undefined ? {} : { url: canonical }),
      ...(image === undefined ? {} : { images: [{ url: image }] }),
    },
    twitter: {
      card: image === undefined ? 'summary' : 'summary_large_image',
      title,
      description,
      ...(image === undefined ? {} : { images: [image] }),
    },
  };
}
