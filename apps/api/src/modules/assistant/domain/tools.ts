/**
 * The tools the model may ask for (plan section 3, phase 1). All are READ: the server runs them
 * with the buyer's own `CallContext`, and what the buyer sees of a result is a card the server
 * builds (ADR-0019 R3, R4). The model never gets a tool that changes anything; the two actions
 * that are not built yet answer "not ready" (plan section 11).
 */

/** The storefront pages the assistant can send the buyer to; the path is built by code (R9). */
export const SITE_PAGES = [
  'home',
  'search',
  'category',
  'cart',
  'checkout',
  'account',
  'personalization',
  'cookies',
] as const;
export type SitePage = (typeof SITE_PAGES)[number];

/** What each page is for, as the model reads it. */
export const SITE_GUIDE: Readonly<Record<SitePage, string>> = Object.freeze({
  home: 'The home page: categories, best sellers and specials.',
  search: 'Search results for a text the buyer typed.',
  category: 'One category and its products (needs category_id).',
  cart: 'The cart: items grouped by seller, quantities, and the button to check out.',
  checkout: 'Checkout: delivery address, delivery options and payment.',
  account: 'My account: orders, profile, saved addresses and sign-in settings.',
  personalization: 'Personalization settings: colour theme and recommendations.',
  cookies: 'Cookie settings and the cookie policy.',
});

const MAX_TEXT = 100;
const MAX_ITEMS = 6;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ToolRequest =
  | { readonly tool: 'search_products'; readonly text: string; readonly categoryId: string | null }
  | { readonly tool: 'list_bestsellers'; readonly categoryId: string | null }
  | { readonly tool: 'list_specials'; readonly categoryId: string | null }
  | { readonly tool: 'list_categories' }
  | { readonly tool: 'show_page'; readonly page: SitePage; readonly categoryId: string | null }
  | { readonly tool: 'support_contact' }
  | { readonly tool: 'suggest_cart_change' }
  | { readonly tool: 'open_support_form' };

export type ToolName = ToolRequest['tool'];

/** How many products one tool call shows at most. */
export const TOOL_ITEM_LIMIT = MAX_ITEMS;

const categoryProperty = {
  category_id: { type: 'string', description: 'A category id from list_categories (optional).' },
};

/** The tool declarations sent to the model; the descriptions are part of the prompt version. */
export const TOOL_DECLARATIONS: readonly {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}[] = Object.freeze([
  {
    name: 'search_products',
    description:
      'Searches the products on sale in this store. The buyer is shown up to 6 product cards ' +
      '(name, seller, price and stock are on the card). You get names and short texts only.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to search for, 2 to 100 characters.' },
        ...categoryProperty,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_bestsellers',
    description: 'Shows the buyer the best-selling products as cards (optionally in a category).',
    inputSchema: { type: 'object', properties: categoryProperty, additionalProperties: false },
  },
  {
    name: 'list_specials',
    description:
      'Shows the buyer the products on special as cards, with their prices on the cards ' +
      '(optionally in a category). You are not told the prices.',
    inputSchema: { type: 'object', properties: categoryProperty, additionalProperties: false },
  },
  {
    name: 'list_categories',
    description: "Lists the store's categories with their ids. Shows the buyer nothing.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_page',
    description:
      'Shows the buyer a link card to a page of the store. Pages: ' +
      Object.entries(SITE_GUIDE)
        .map(([page, about]) => `${page}: ${about}`)
        .join(' '),
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'string', enum: [...SITE_PAGES] }, ...categoryProperty },
      required: ['page'],
      additionalProperties: false,
    },
  },
  {
    name: 'support_contact',
    description:
      "Shows the buyer the store's support contact card, for anything you must not handle: " +
      'payments, refunds, orders, addresses, accounts, discount codes, complaints, or a person.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'suggest_cart_change',
    description: 'Suggests adding, removing or changing an item in the cart. Not available yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'open_support_form',
    description: 'Opens a support form inside the chat window. Not available yet.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
]);

const optionalId = (value: unknown): string | null | undefined =>
  value === undefined || value === null
    ? null
    : typeof value === 'string' && ID.test(value)
      ? value
      : undefined;

/**
 * A tool call as the model wrote it, checked (R9: model output is schema-validated). null when
 * the name is unknown or the input does not fit; the model is then told the call was refused.
 */
export function parseToolCall(name: string, input: unknown): ToolRequest | null {
  const fields =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const categoryId = optionalId(fields.category_id);
  switch (name) {
    case 'search_products': {
      const text = typeof fields.text === 'string' ? fields.text.trim() : '';
      if (text.length < 2 || text.length > MAX_TEXT || categoryId === undefined) return null;
      return { tool: name, text, categoryId };
    }
    case 'list_bestsellers':
    case 'list_specials':
      return categoryId === undefined ? null : { tool: name, categoryId };
    case 'show_page': {
      const page = fields.page;
      if (typeof page !== 'string' || !(SITE_PAGES as readonly string[]).includes(page)) {
        return null;
      }
      if (categoryId === undefined || (page === 'category') !== (categoryId !== null)) return null;
      return { tool: name, page: page as SitePage, categoryId };
    }
    case 'list_categories':
    case 'support_contact':
    case 'suggest_cart_change':
    case 'open_support_form':
      return { tool: name };
    default:
      return null;
  }
}
