import type { MetadataRoute } from 'next';

// Read per request, like the noindex header, so the file follows the switch without a rebuild.
export const dynamic = 'force-dynamic';

/**
 * Allows every crawler on every path, whether indexing is on or off. Never `Disallow: /`: a page
 * blocked here is never fetched, so its noindex is never seen and its URL can still be listed.
 * Disallow rules and the sitemap come with SEO package 4.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/' } };
}
