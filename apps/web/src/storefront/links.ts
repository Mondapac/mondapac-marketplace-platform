// The path of a buyer-site page that more than one place links to, so a change of the address
// (SEO package 5's `/p/<name>-<id>`) reaches every link and the sitemap together.

/** The product page of a product id. */
export const productHref = (id: string): string => `/p/${id}`;

/** The category page of a category slug, or of a subcategory under it. */
export const categoryHref = (category: string, sub?: string): string =>
  sub === undefined ? `/c/${category}` : `/c/${category}/${sub}`;
