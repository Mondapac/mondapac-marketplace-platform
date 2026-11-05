// The path of a buyer-site page that more than one place links to, so a change of the address
// (SEO package 5's `/p/<name>-<id>`) reaches every link and the sitemap together.

/** The product page of a product id. */
export const productHref = (id: string): string => `/p/${id}`;

/** The shape of a category slug (catalog's own pattern); the API answers nothing else. */
export const CATEGORY_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/**
 * The category page of a category slug, at any depth (categories C6: one segment, `/c/<slug>`).
 * The slug is encoded, so a value that is not a slug can never leave the `/c/` path.
 */
export const categoryHref = (slug: string): string => `/c/${encodeURIComponent(slug)}`;
