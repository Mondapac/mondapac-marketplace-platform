import type { MetadataRoute } from 'next';
import { LISTING_FILTER_PARAMS } from '../src/catalog/listing-state.ts';
import { SELLERS_FILTER_PARAMS } from '../src/sellers/sellers-state.ts';
import { indexingOn } from '../src/seo/indexing.ts';
import { sitemapHost } from '../src/seo/sitemap.ts';

// Read per request, like the noindex header, so the file follows the switch without a rebuild.
export const dynamic = 'force-dynamic';

/** Pages that are never worth a crawl, whatever their meta tags say. */
const BLOCKED_PATHS = ['/search', '/cart', '/checkout', '/account'];

/** The path itself, its sub-paths and its query, but not a longer name such as `/searchable`. */
const blockRules = (path: string): string[] => [`${path}$`, `${path}/`, `${path}?`];

/**
 * A listing URL that carries a filter or sort parameter is a copy of its plain page. `?page=` is
 * not blocked: paged listings stay indexable (SEO package 1). The names come from the listing
 * and sellers state files, which read them.
 */
function filterRules(): string[] {
  const names = [...new Set([...LISTING_FILTER_PARAMS, ...SELLERS_FILTER_PARAMS])];
  return names.flatMap((name) => [`/*?${name}=`, `/*&${name}=`]);
}

/**
 * With indexing off: allow every crawler on every path and add no rule. Never `Disallow: /`, and
 * no other Disallow either: a blocked page is never fetched, so its noindex is never seen and its
 * URL can still be listed. With indexing on, the Disallow rules and, on a listed AU host, the
 * Sitemap line (SEO plan, package 4).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  if (!indexingOn()) return { rules: { userAgent: '*', allow: '/' } };
  const host = await sitemapHost();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [...BLOCKED_PATHS.flatMap(blockRules), ...filterRules()],
    },
    ...(host === undefined ? {} : { sitemap: `${host.origin}/sitemap.xml` }),
  };
}
