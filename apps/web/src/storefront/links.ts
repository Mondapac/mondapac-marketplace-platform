// The path of a buyer-site page that more than one place links to, so a change of the address
// reaches every link and the sitemap together (SEO package 5: `/p/<name>-<id>`).

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WHOLE_UUID = new RegExp(`^${UUID}$`, 'iu');
const TRAILING_UUID = new RegExp(`(${UUID})$`, 'iu');

/** Longest name part of a product path, cut at a word boundary. */
const SLUG_MAX = 60;

/**
 * The name part of a product path: lower-case ASCII `a-z0-9` with single hyphens, accents folded,
 * every other character dropped (an apostrophe leaves no gap, other characters separate words),
 * cut at a word boundary at about 60 characters. Empty when nothing usable is left.
 */
export function productSlug(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (folded.length <= SLUG_MAX) return folded;
  const head = folded.slice(0, SLUG_MAX + 1);
  // A hyphen at the cut keeps the last word whole; otherwise back up to the previous boundary.
  const boundary = head.endsWith('-') ? SLUG_MAX : head.lastIndexOf('-');
  return (boundary > 0 ? head.slice(0, boundary) : head.slice(0, SLUG_MAX)).replace(/-+$/u, '');
}

/**
 * The product page of a product id: `/p/<slug>-<id>`, or `/p/<id>` when no name is known or the
 * name leaves no slug. Only a catalog id (a UUID) takes a name part; it is written lower-case.
 * Any other id (the sample data's) is the whole path.
 */
export function productHref(id: string, name?: string): string {
  if (!WHOLE_UUID.test(id)) return `/p/${encodeURIComponent(id)}`;
  const uuid = id.toLowerCase();
  const slug = name === undefined ? '' : productSlug(name);
  return slug === '' ? `/p/${uuid}` : `/p/${slug}-${uuid}`;
}

/**
 * The product id of the `[id]` segment: the trailing UUID, in lower case, whatever comes before
 * it. A segment with no UUID at its end is returned as it is (only the sample data has such ids;
 * with the API on, nothing is found for it and the route answers 404).
 */
export function productIdOfSegment(segment: string): string {
  const match = TRAILING_UUID.exec(segment);
  return match === null ? segment : match[1]!.toLowerCase();
}

/** The category page of a category slug, or of a subcategory under it. */
export const categoryHref = (category: string, sub?: string): string =>
  sub === undefined ? `/c/${category}` : `/c/${category}/${sub}`;
