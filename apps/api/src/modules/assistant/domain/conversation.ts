import { parseId } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { Retention } from './assistant-settings';
import { maskPersonalData } from './personal-data';
import { SITE_PAGES, type SitePage } from './tools';

/** The longest message a buyer may send, in characters (plan section 8). */
export const MAX_MESSAGE_CHARACTERS = 1000;
/** Buyer messages per conversation (plan section 8); a full one asks the buyer to start anew. */
export const MAX_TURNS = 30;
/** Earlier messages sent with a new one, at most; older ones are left out of the model's view. */
export const HISTORY_MESSAGES = 12;
/** Tool calls the server runs in one model round; more are answered as refused. */
export const MAX_TOOL_CALLS_PER_ROUND = 3;
/** Cards one turn shows (the stored card refs allow 40); the support card always fits. */
export const MAX_CARDS_PER_TURN = 24;
/** Model calls in one buyer turn: the answer and up to three rounds of tool results. */
export const MAX_MODEL_ROUNDS = 4;
/** Input tokens of one model call: system text, history and tool results (G2 enforces it). */
export const MAX_INPUT_TOKENS = 60_000;
/** Output tokens of one model call. */
export const MAX_OUTPUT_TOKENS = 600;
/** One model call is cut after this (plan section 8: unavailable or slower than 15 seconds). */
export const MODEL_TIMEOUT_MS = 15_000;
/** All model calls of one turn together. */
export const TURN_BUDGET_MS = 25_000;

// Controls other than tab and line breaks, and the characters that reorder or hide text.
const REFUSED_CHARACTERS = /(?![\t\n\r‌])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface FieldError {
  readonly path: string;
  readonly code: 'type' | 'range' | 'format';
}

/**
 * The conversation id the widget generates: a canonical UUID v7, like every id of the platform,
 * because the conversation is the subject of its own encryption key (ADR-0019 R5).
 */
export function parseConversationId(value: unknown): Result<string, FieldError> {
  return typeof value === 'string' && parseId(value).ok
    ? { ok: true, value }
    : { ok: false, error: { path: 'id', code: 'format' } };
}

/** The buyer's message: 1 to 1000 characters once trimmed, no hidden or control characters. */
export function parseMessageText(value: unknown): Result<string, FieldError> {
  if (typeof value !== 'string') return { ok: false, error: { path: 'text', code: 'type' } };
  const text = value.trim();
  if (text.length === 0 || [...text].length > MAX_MESSAGE_CHARACTERS) {
    return { ok: false, error: { path: 'text', code: 'range' } };
  }
  if (REFUSED_CHARACTERS.test(text)) return { ok: false, error: { path: 'text', code: 'format' } };
  return { ok: true, value: text };
}

/**
 * How long a conversation is kept, in days (plan section 11): 0 keeps no text at all. A guest's
 * is kept at most 30 days whatever the setting.
 */
export function retentionDaysOf(retention: Retention, caller: 'guest' | 'customer'): number {
  switch (retention) {
    case 'none':
      return 0;
    case '30-days':
      return 30;
    case '12-months':
      return caller === 'guest' ? 30 : 365;
  }
}

// The cost of each call is computed and capped by platform/ai's gateway (`AiGateway.run`), at the
// route's price; the chat's day and month caps are the gateway's (AI Gateway G4d2).

/** The longest title of a conversation in the buyer's list, in characters (stage 0, B2). */
export const TITLE_CHARACTERS = 30;
/** Conversations one page of the buyer's list shows by default, and at most. */
export const HISTORY_PAGE_DEFAULT = 20;
export const HISTORY_PAGE_MAX = 50;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * A conversation's title in the buyer's list: its first buyer message on one line, masked again
 * (it was masked before it was stored), cut to 30 characters (user-perceived characters, so an
 * emoji or a combined letter is never split) with an ellipsis. Empty when no text is readable.
 */
export function conversationTitle(firstBuyerText: string | null): string {
  if (firstBuyerText === null) return '';
  const line = maskPersonalData(firstBuyerText).replace(/\s+/gu, ' ').trim();
  const characters = [...GRAPHEMES.segment(line)].map((part) => part.segment);
  if (characters.length <= TITLE_CHARACTERS) return line;
  return `${characters
    .slice(0, TITLE_CHARACTERS - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * The retention in force for a conversation that stored `storedDays`: the shorter of that and the
 * current setting (plan section 11: a lower setting shortens older conversations too). 0 when no
 * text is kept, so the buyer's list never shows it.
 */
export const retentionInForce = (storedDays: number, currentDays: number): number =>
  Math.min(storedDays, currentDays);

/** A card of a stored reply: the kind and ids it was stored with, never its text or price. */
export type StoredCard =
  | { readonly kind: 'product'; readonly offerId: string }
  | { readonly kind: 'seller'; readonly sellerId: string }
  | { readonly kind: 'page'; readonly page: SitePage }
  | { readonly kind: 'support' };

/** Reads a stored card ref (see `cardRefOf`); an unknown one is left out. */
export function storedCardOf(ref: string): StoredCard | null {
  if (ref === 'support') return { kind: 'support' };
  const [kind, value, ...rest] = ref.split(':');
  if (rest.length > 0 || value === undefined || value.length === 0) return null;
  if (kind === 'product' && parseId(value).ok) return { kind: 'product', offerId: value };
  if (kind === 'seller' && parseId(value).ok) return { kind: 'seller', sellerId: value };
  if (kind === 'page' && (SITE_PAGES as readonly string[]).includes(value)) {
    return { kind: 'page', page: value as SitePage };
  }
  return null;
}
