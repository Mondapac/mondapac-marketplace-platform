// The buyer assistant's client side (package 5): what the widget is told by the storefront, the
// conversation contract of `POST /assistant/conversations/:id/messages` (package 4, PR #437) and
// the parts of a reply the widget renders. Model text arrives as plain sentences and is rendered
// as text only; every link and number the buyer sees is built here or by the server's cards (R9).

/**
 * What the server render knows about the assistant: the parts that need no visitor id. null from
 * the source means the assistant is off. The widget asks the API the rest in the browser
 * (`GET <chatUrl>/storefront`, see {@link StorefrontRead}) and renders nothing until it says on.
 */
export interface AssistantBase {
  /** `https://host/assistant` or `/api/assistant` (the buyer relay): no trailing slash. */
  readonly chatUrl: string;
  /** The Market's support address, for "Talk to support" (Market configuration). */
  readonly supportEmail: string;
  /** The session's CSRF token, sent for a signed-in customer; null for a guest. */
  readonly csrfToken: string | null;
}

/** The server's answer of `GET /assistant/storefront`, checked field by field. */
export interface StorefrontRead {
  readonly enabled: boolean;
  /** A guest may chat; false asks a guest to log in first. */
  readonly guestsAllowed: boolean;
  /** The admin's welcome text (up to 200 characters); null shows the storefront default. */
  readonly welcomeText: string | null;
  /** Days a chat is kept, for a signed-in customer and for a guest (0: not kept). */
  readonly retentionDays: { readonly customer: number; readonly guest: number } | null;
  /** Quick prompt texts in the buyer's language; empty shows the storefront defaults. */
  readonly quickPrompts: readonly string[];
  /** A valid internal preview token was sent: the panel marks itself a preview. */
  readonly preview: boolean;
}

/** What the widget needs once the assistant is on for this visitor. */
export interface AssistantSetup extends AssistantBase {
  readonly guestsAllowed: boolean;
  readonly welcomeText: string | null;
  /** How long chats are kept for the viewer (0: not kept); null words it without a number. */
  readonly retentionDays: number | null;
  readonly quickPrompts?: readonly string[];
  readonly preview?: boolean;
}

/** A plain address only: no query, scheme or markup can ride in a `mailto:` link built from it. */
const PLAIN_EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The Market's support address when it is a plain one; null otherwise (the assistant stays off). */
export function validSupportEmail(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 254) return null;
  if (!PLAIN_EMAIL.test(value) || value.includes('..')) return null;
  return value;
}

/**
 * The conversation route's base: an https absolute URL (no credentials, query or fragment) or a
 * relative path starting with one `/`; anything else is null (the assistant stays off).
 */
export function validChatUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null;
  // Whitespace, control characters, backslash, query and fragment never belong in a route base.
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || char === '\\' || char === '?' || char === '#') return null;
  }
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null;
    return value.replace(/\/+$/u, '') || null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const path = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${path}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const retentionDay = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3650
    ? value
    : null;

/** Longest quick prompt the widget sends as a message, and how many it shows. */
const PROMPT_MAX = 120;
const PROMPTS_MAX = 6;

/** The answer of `GET <chatUrl>/storefront`, or null when it is not the shape the API sends. */
export function storefrontReadOf(data: unknown): StorefrontRead | null {
  if (!isRecord(data) || typeof data.enabled !== 'boolean' || typeof data.preview !== 'boolean')
    return null;
  if (typeof data.guestsAllowed !== 'boolean') return null;
  if (data.welcomeText !== null && typeof data.welcomeText !== 'string') return null;
  let retention: StorefrontRead['retentionDays'] = null;
  if (data.retentionDays !== null) {
    if (!isRecord(data.retentionDays)) return null;
    const customer = retentionDay(data.retentionDays.customer);
    const guest = retentionDay(data.retentionDays.guest);
    if (customer === null || guest === null) return null;
    retention = { customer, guest };
  }
  const prompts = Array.isArray(data.quickPrompts) ? (data.quickPrompts as unknown[]) : [];
  const quickPrompts = prompts
    .flatMap((prompt) => (typeof prompt === 'string' ? [prompt.trim()] : []))
    .filter((prompt) => prompt !== '' && prompt.length <= PROMPT_MAX)
    .slice(0, PROMPTS_MAX);
  return {
    enabled: data.enabled,
    guestsAllowed: data.guestsAllowed,
    welcomeText: text(data.welcomeText, 200),
    retentionDays: retention,
    quickPrompts,
    preview: data.preview,
  };
}

/** The header that carries the internal preview token to the API (the only place it goes). */
export const PREVIEW_HEADER = 'x-assistant-preview';

/** The quick prompts of the opening (handoff defaults; the cart action one needs cart suggestions). */
export const QUICK_PROMPTS = [
  'quick-halal',
  'quick-specials',
  'quick-cart',
  'quick-delivery',
] as const;

/** The longest message the box takes (the server allows more; the design caps it at 500). */
export const MESSAGE_LIMIT = 500;

/** The storefront pages a `page` card can open; the path is built here, never from the model. */
export type SitePage =
  'home' | 'search' | 'category' | 'cart' | 'checkout' | 'account' | 'personalization' | 'cookies';

/** Integer minor units plus an ISO 4217 code, as a card carries it. */
export interface CardMoney {
  readonly amount: number;
  readonly currency: string;
}

export interface CardBadge {
  readonly typeCode: string;
  readonly typeName: string;
  /** Only the seller's own declaration: shown as the product page shows it, never as certified. */
  readonly sellerClaim: boolean;
}

export type ProductCard = {
  readonly kind: 'product';
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly name: string;
  readonly shortText: string | null;
  readonly sellerName: string | null;
  /** The buyer price from pricing; null shows none. */
  readonly price: CardMoney | null;
  /** The regular price, only on a special. */
  readonly regularPrice: CardMoney | null;
  readonly taxInclusive: boolean | null;
  readonly priceFrom: boolean;
  readonly badges: readonly CardBadge[];
};

export type SellerCard = {
  readonly kind: 'seller';
  readonly sellerId: string;
  readonly slug: string;
  readonly name: string;
  readonly city: string | null;
  /** The year the store started selling; null when the API sent none usable. */
  readonly sellingSince: number | null;
  readonly productCount: number | null;
};

export type AssistantCard =
  | ProductCard
  | SellerCard
  | { readonly kind: 'page'; readonly page: SitePage; readonly categoryId: string | null }
  | { readonly kind: 'support'; readonly email: string | null };

export type AssistantNotice =
  | 'see-cards'
  | 'see-certification'
  | 'cart-actions-not-ready'
  | 'support-form-not-ready'
  | 'unavailable'
  | 'refused'
  | 'tool-failed';

const NOTICES: readonly AssistantNotice[] = [
  'see-cards',
  'see-certification',
  'cart-actions-not-ready',
  'support-form-not-ready',
  'unavailable',
  'refused',
  'tool-failed',
];

const PAGES: readonly SitePage[] = [
  'home',
  'search',
  'category',
  'cart',
  'checkout',
  'account',
  'personalization',
  'cookies',
];

/** One answered turn, in the order the widget shows it. */
export interface AssistantReply {
  readonly conversationId: string;
  readonly sentences: readonly string[];
  readonly products: readonly ProductCard[];
  /** Cards in the order they arrived: the stores come after the products. */
  readonly sellers: readonly SellerCard[];
  readonly pages: readonly Extract<AssistantCard, { kind: 'page' }>[];
  readonly support: boolean;
  readonly notices: readonly AssistantNotice[];
}

/** Why a message got no answer, as the widget shows it. */
export type AssistantRefusal =
  | { readonly kind: 'off' }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'limit'; readonly retryAfterSeconds: number }
  | { readonly kind: 'full' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'error' };

export type SendResult =
  | { readonly ok: true; readonly reply: AssistantReply }
  | { readonly ok: false; readonly refusal: AssistantRefusal };

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

/** Ids on cards are UUIDs; anything else is dropped, so no id can bend a path (`..`, `/`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

/** The store slug the storefront's own store page accepts (`/s/<slug>`, at most 50 characters). */
const STORE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BADGE_CODE = /^[A-Za-z0-9_-]{1,40}$/;
const CURRENCY = /^[A-Z]{3}$/;
const BADGES_MAX = 6;

/**
 * Money as the API sends it (the amount is a string of digits, minor units): a whole non-negative
 * amount in safe-integer range and an ISO 4217 code, else null. Nothing is assumed about the currency.
 */
export function moneyOf(value: unknown): CardMoney | null {
  if (!isRecord(value)) return null;
  const { amount, currency } = value;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  let minor: number;
  if (typeof amount === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(amount)) minor = Number(amount);
  else if (typeof amount === 'number' && Number.isInteger(amount) && amount >= 0) minor = amount;
  else return null;
  return Number.isSafeInteger(minor) ? { amount: minor, currency } : null;
}

/** A price field that is absent or null is none; present but malformed drops the price (`undefined`). */
const priceOf = (value: unknown): CardMoney | null | undefined =>
  value === null || value === undefined ? null : (moneyOf(value) ?? undefined);

function badgesOf(value: unknown): CardBadge[] {
  if (!Array.isArray(value)) return [];
  const badges: CardBadge[] = [];
  for (const raw of (value as unknown[]).slice(0, BADGES_MAX)) {
    if (!isRecord(raw)) continue;
    const typeName = text(raw.typeName, 60);
    if (typeof raw.typeCode !== 'string' || !BADGE_CODE.test(raw.typeCode) || !typeName) continue;
    if (typeof raw.sellerClaim !== 'boolean') continue;
    badges.push({ typeCode: raw.typeCode, typeName, sellerClaim: raw.sellerClaim });
  }
  return badges;
}

/**
 * A card from the stream, or null when it is not one the widget knows. Every field is checked: a
 * malformed price is dropped (the row shows none), a malformed identity drops the card.
 */
export function cardOf(data: unknown): AssistantCard | null {
  if (typeof data !== 'object' || data === null) return null;
  const card = data as Record<string, unknown>;
  if (card.kind === 'product') {
    const offerId = id(card.offerId);
    const productId = id(card.productId);
    const sellerId = id(card.sellerId);
    const name = text(card.name, 200);
    if (!offerId || !productId || !sellerId || !name) return null;
    const price = priceOf(card.price);
    const regular = priceOf(card.regularPrice);
    // A price that does not parse, or a regular price with no price beside it in the same
    // currency, is never shown: a struck-through figure with nothing to compare is misleading.
    const shown = price ?? null;
    const regularPrice =
      shown !== null &&
      regular !== undefined &&
      regular !== null &&
      regular.currency === shown.currency &&
      regular.amount > shown.amount
        ? regular
        : null;
    return {
      kind: 'product',
      offerId,
      productId,
      sellerId,
      name,
      shortText: text(card.shortText, 200),
      sellerName: text(card.sellerName, 120),
      price: shown,
      regularPrice,
      taxInclusive: typeof card.taxInclusive === 'boolean' ? card.taxInclusive : null,
      priceFrom: shown !== null && card.priceFrom === true,
      badges: badgesOf(card.badges),
    };
  }
  if (card.kind === 'seller') {
    const sellerId = id(card.sellerId);
    const name = text(card.name, 120);
    const slug =
      typeof card.slug === 'string' && card.slug.length <= 50 && STORE_SLUG.test(card.slug)
        ? card.slug
        : null;
    const since = card.sellingSince;
    if (!sellerId || !name || slug === null) return null;
    const count = card.productCount;
    return {
      kind: 'seller',
      sellerId,
      slug,
      name,
      city: text(card.city, 80),
      sellingSince:
        typeof since === 'number' && Number.isInteger(since) && since >= 1900 && since <= 2200
          ? since
          : null,
      productCount:
        typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 10_000_000
          ? count
          : null,
    };
  }
  if (card.kind === 'page' && PAGES.includes(card.page as SitePage)) {
    const categoryId =
      card.categoryId === null || card.categoryId === undefined ? null : id(card.categoryId);
    if (card.categoryId !== null && card.categoryId !== undefined && categoryId === null)
      return null;
    return { kind: 'page', page: card.page as SitePage, categoryId };
  }
  if (card.kind === 'support') return { kind: 'support', email: text(card.email, 254) };
  return null;
}

/** Reads a whole `text/event-stream` body into a reply; null when it is cut off or malformed. */
export function replyOf(body: string): AssistantReply | null {
  let conversationId: string | null = null;
  let done = false;
  const sentences: string[] = [];
  const cards: AssistantCard[] = [];
  const notices: AssistantNotice[] = [];
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    let name = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(data.join('\n'));
    } catch {
      return null;
    }
    const field = (key: string) =>
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
    if (name === 'conversation') conversationId = text(field('id'), 64);
    else if (name === 'text') {
      const sentence = text(field('text'), 2000);
      if (sentence) sentences.push(sentence);
    } else if (name === 'card') {
      const card = cardOf(value);
      if (card) cards.push(card);
    } else if (name === 'notice') {
      const code = field('code');
      if (NOTICES.includes(code as AssistantNotice)) notices.push(code as AssistantNotice);
    } else if (name === 'done') done = true;
  }
  if (!done || conversationId === null) return null;
  return {
    conversationId,
    sentences,
    products: cards.filter((card) => card.kind === 'product'),
    sellers: cards.filter((card) => card.kind === 'seller'),
    pages: cards.filter((card) => card.kind === 'page'),
    support: cards.some((card) => card.kind === 'support'),
    notices: [...new Set(notices)],
  };
}

/** The widget's state for a refused message (`{ statusCode, code }` errors of package 4). */
export function refusalOf(
  status: number,
  code: unknown,
  retryAfter: string | null,
): AssistantRefusal {
  if (code === 'assistant.off') return { kind: 'off' };
  if (code === 'assistant.sign-in-required') return { kind: 'sign-in' };
  if (code === 'assistant.paused' || code === 'assistant.unavailable')
    return { kind: 'unavailable' };
  if (code === 'assistant.conversation-full') return { kind: 'full' };
  if (code === 'assistant.conversation-not-found') return { kind: 'lost' };
  if (status === 429) {
    const seconds = Number(retryAfter);
    return {
      kind: 'limit',
      retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60,
    };
  }
  if (status === 503) return { kind: 'unavailable' };
  return { kind: 'error' };
}

/** Sends one message and reads the whole answer; a network failure or a broken stream is `error`. */
export async function sendMessage(
  setup: AssistantSetup,
  conversationId: string,
  message: string,
  visitor: string | null,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  /** An internal preview token, sent as `x-assistant-preview` and nowhere else. */
  preview: string | null = null,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (setup.csrfToken !== null) headers['X-CSRF-Token'] = setup.csrfToken;
  if (preview !== null) headers[PREVIEW_HEADER] = preview;
  const response = await fetcher(
    `${setup.chatUrl}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(visitor === null ? { text: message } : { text: message, visitor }),
      signal,
    },
  );
  if (!response.ok) {
    let code: unknown;
    try {
      code = ((await response.json()) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    return {
      ok: false,
      refusal: refusalOf(response.status, code, response.headers.get('Retry-After')),
    };
  }
  const reply = replyOf(await response.text());
  return reply === null ? { ok: false, refusal: { kind: 'error' } } : { ok: true, reply };
}

/** The storefront path of a page card. */
export function pagePath(card: Extract<AssistantCard, { kind: 'page' }>): string | null {
  switch (card.page) {
    case 'home':
      return '/';
    case 'search':
      return '/search';
    case 'category':
      return card.categoryId === null ? null : `/c/${encodeURIComponent(card.categoryId)}`;
    case 'cart':
      return '/cart';
    case 'checkout':
      return '/checkout';
    case 'account':
      return '/account';
    case 'personalization':
      return '/account/personalization';
    case 'cookies':
      return '/cookies';
  }
}

/** The search page for what the buyer asked ("See all results"). */
export const searchPath = (query: string): string =>
  `/search?q=${encodeURIComponent(query.trim().slice(0, 100))}`;

/** A new conversation id: a canonical UUID v7 (the server accepts nothing else). */
export function newConversationId(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const VISITOR_KEY = 'sf-assistant-visitor';
const VISITOR = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * This browser's random visitor id (keeps it in or out of a percentage rollout), or null when the
 * browser keeps no storage. It identifies nothing but the rollout bucket.
 */
export function visitorId(storage: Pick<Storage, 'getItem' | 'setItem'> | null): string | null {
  try {
    const kept = storage?.getItem(VISITOR_KEY) ?? null;
    if (kept !== null && VISITOR.test(kept)) return kept;
    const fresh = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    storage?.setItem(VISITOR_KEY, fresh);
    return storage ? fresh : null;
  } catch {
    return null;
  }
}
