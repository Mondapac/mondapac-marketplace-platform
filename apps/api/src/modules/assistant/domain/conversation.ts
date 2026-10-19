import { parseId } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { AssistantSettings, Retention } from './assistant-settings';

/** The longest message a buyer may send, in characters (plan section 8). */
export const MAX_MESSAGE_CHARACTERS = 1000;
/** Buyer messages per conversation (plan section 8); a full one asks the buyer to start anew. */
export const MAX_TURNS = 30;
/** Earlier messages sent with a new one, at most; older ones are left out of the model's view. */
export const HISTORY_MESSAGES = 12;
/** Model calls in one buyer turn: the answer and up to three rounds of tool results. */
/** Tool calls the server runs in one model round; more are answered as refused. */
export const MAX_TOOL_CALLS_PER_ROUND = 3;
/** Cards one turn shows (the stored card refs allow 40); the support card always fits. */
export const MAX_CARDS_PER_TURN = 24;
export const MAX_MODEL_ROUNDS = 4;
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

/** Spend is counted in micro US dollars (1e-6 USD); the caps are set in US cents. */
export const MICRO_USD_PER_CENT = 10_000;

/** What one model call cost, rounded up to a whole micro dollar. */
export function costMicroUsd(
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  price: { readonly inputPicoUsd: number; readonly outputPicoUsd: number },
): number {
  const pico = usage.inputTokens * price.inputPicoUsd + usage.outputTokens * price.outputPicoUsd;
  return Math.ceil(pico / 1_000_000);
}

/**
 * The usage counted for a call cut at its timeout: every character of the request as a token
 * (more than any tokenizer counts) and the whole output allowance.
 */
export function timeoutUsageOf(request: {
  readonly system: string;
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly maxOutputTokens: number;
}): { readonly inputTokens: number; readonly outputTokens: number } {
  const characters =
    request.system.length +
    JSON.stringify(request.messages).length +
    JSON.stringify(request.tools).length;
  return { inputTokens: characters, outputTokens: request.maxOutputTokens };
}

/** Which cap the Market's spend has reached, if any; the daily one is checked first. */
export function capReached(
  settings: Pick<AssistantSettings, 'dailySpendCapUsdCents' | 'monthlySpendCapUsdCents'>,
  spend: { readonly todayMicroUsd: number; readonly monthMicroUsd: number },
): 'daily' | 'monthly' | null {
  if (spend.todayMicroUsd >= settings.dailySpendCapUsdCents * MICRO_USD_PER_CENT) return 'daily';
  if (spend.monthMicroUsd >= settings.monthlySpendCapUsdCents * MICRO_USD_PER_CENT) {
    return 'monthly';
  }
  return null;
}
