// The buyer assistant's client side (package 5): what the widget is told by the storefront, the
// conversation contract of `POST /assistant/conversations/:id/messages` (package 4, PR #437) and
// the parts of a reply the widget renders. Model text arrives as plain sentences and is rendered
// as text only; every link and number the buyer sees is built here or by the server's cards (R9).

/** What the storefront tells the widget; null from the source means the assistant is off. */
export interface AssistantSetup {
  /** `scheme://host/assistant` or `/assistant`: the conversation route's base, no trailing slash. */
  readonly chatUrl: string;
  /** A guest may chat; false asks a guest to log in first. */
  readonly guestsAllowed: boolean;
  /** The admin's welcome text (up to 200 characters); null shows the storefront default. */
  readonly welcomeText: string | null;
  /** The Market's support address, for "Talk to support" (Market configuration). */
  readonly supportEmail: string;
  /** How long chats are kept (the admin's retention setting); null words it without a number. */
  readonly retentionDays: number | null;
  /** The session's CSRF token, sent for a signed-in customer; null for a guest. */
  readonly csrfToken: string | null;
}

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

export type AssistantCard =
  | {
      readonly kind: 'product';
      readonly offerId: string;
      readonly productId: string;
      readonly sellerId: string;
      readonly name: string;
      readonly shortText: string | null;
    }
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
  readonly products: readonly Extract<AssistantCard, { kind: 'product' }>[];
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

/** A card from the stream, or null when it is not one the widget knows. Prices are dropped. */
export function cardOf(data: unknown): AssistantCard | null {
  if (typeof data !== 'object' || data === null) return null;
  const card = data as Record<string, unknown>;
  if (card.kind === 'product') {
    const offerId = id(card.offerId);
    const productId = id(card.productId);
    const sellerId = id(card.sellerId);
    const name = text(card.name, 200);
    if (!offerId || !productId || !sellerId || !name) return null;
    return {
      kind: 'product',
      offerId,
      productId,
      sellerId,
      name,
      shortText: text(card.shortText, 200),
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
): Promise<SendResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (setup.csrfToken !== null) headers['X-CSRF-Token'] = setup.csrfToken;
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
