// The default texts and rules of the buyer site's head tags (SEO plan, package 1). Every template
// lives here or, for the words, in messages/en.json under `seo`; admin package S5 swaps this source
// for the Market's settings without touching the pages.

/** `%s` is the page's own name, `{store}` the store title. */
export const TITLE_TEMPLATE = '%s | {store}';

/** A page's own name in the title is cut at a word boundary to about this many characters. */
export const TITLE_NAME_MAX = 60;

/** Descriptions are cut at a word boundary to about this many characters. */
export const DESCRIPTION_MAX = 155;

/**
 * The image shared when a page has none of its own (Open Graph, Twitter card). None yet: the store
 * image waits for the brand; until then such pages share no image.
 */
export const DEFAULT_IMAGE: string | undefined = undefined;

/**
 * The message key (namespace `seo.descriptions`) of each page type's description. Placeholders
 * are filled from the page's data only.
 */
export const DESCRIPTION_KEYS = {
  home: 'home',
  category: 'category',
  subcategory: 'subcategory',
  /** A product without a description of its own. */
  product: 'product',
  seller: 'seller',
  sellers: 'sellers',
  search: 'search',
  'search-results': 'search-results',
  cart: 'cart',
  checkout: 'checkout',
  payment: 'payment',
  confirmation: 'confirmation',
  'not-completed': 'not-completed',
  'account-overview': 'account-overview',
  'account-orders': 'account-orders',
  'account-order': 'account-order',
  'account-addresses': 'account-addresses',
  'account-lists': 'account-lists',
  'account-settings': 'account-settings',
  personalization: 'personalization',
  'coming-soon': 'coming-soon',
  cookies: 'cookies',
  sell: 'sell',
  offline: 'offline',
  'unavailable-product': 'unavailable-product',
  'closed-store': 'closed-store',
} as const;

export type DescriptionKey = keyof typeof DESCRIPTION_KEYS;

/** The title template with the store title in it, as Next's `title.template` takes it. */
export function titleTemplate(store: string): string {
  return TITLE_TEMPLATE.replace('{store}', () => store);
}

/** A page's full title. A function replacer, so `$` in a name is never a pattern. */
export function pageTitle(name: string, store: string): string {
  return titleTemplate(store).replace('%s', () => name);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/gu;

/** Text for a head tag: no control characters, whitespace collapsed. Never HTML. */
export function plainText(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

/** A description of at most DESCRIPTION_MAX characters plus an ellipsis, cut between words. */
export function cutDescription(text: string, max = DESCRIPTION_MAX): string {
  const plain = plainText(text);
  const chars = Array.from(plain);
  if (chars.length <= max) return plain;
  const head = chars.slice(0, max + 1).join('');
  const space = head.lastIndexOf(' ');
  // One long word: cut it rather than leave the description empty.
  const cut = space > max / 2 ? head.slice(0, space) : chars.slice(0, max).join('');
  return `${cut.replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** A page's own name for its title: plain text, cut like a description to TITLE_NAME_MAX. */
export function cutTitle(name: string): string {
  return cutDescription(name, TITLE_NAME_MAX);
}
