import type { Result } from '@mondapac/shared-kernel';
import type { FieldError } from './conversation';

/** A buyer's thumbs on one assistant message. */
export const RATINGS = ['up', 'down'] as const;
export type Rating = (typeof RATINGS)[number];

/** Why a thumbs down: the answer was wrong, nothing was found, or something else. */
export const FEEDBACK_REASONS = ['wrong', 'not-found', 'other'] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** A conversation holds at most 30 buyer messages, so at most 60 messages (table CHECK). */
export const MAX_MESSAGE_POSITION = 60;

export interface Feedback {
  readonly rating: Rating;
  readonly reason: FeedbackReason | null;
}

/** The message a thumb is on: its position in the conversation, 1 to 60, plain digits only. */
export function parseMessagePosition(value: unknown): Result<number, FieldError> {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,1}$/.test(value)) {
    return { ok: false, error: { path: 'messageId', code: 'format' } };
  }
  const position = Number(value);
  return position <= MAX_MESSAGE_POSITION
    ? { ok: true, value: position }
    : { ok: false, error: { path: 'messageId', code: 'range' } };
}

/**
 * The body of a feedback request: `rating` is required; `reason` is allowed (and optional) only
 * with a thumbs down. Every fault is listed, none is guessed.
 */
export function parseFeedback(input: {
  readonly rating: unknown;
  readonly reason: unknown;
}): Result<Feedback, readonly FieldError[]> {
  const errors: FieldError[] = [];
  const rating = RATINGS.find((candidate) => candidate === input.rating);
  if (rating === undefined) errors.push({ path: 'rating', code: 'format' });
  let reason: FeedbackReason | null = null;
  if (input.reason !== undefined && input.reason !== null) {
    const found = FEEDBACK_REASONS.find((candidate) => candidate === input.reason);
    if (found === undefined) errors.push({ path: 'reason', code: 'format' });
    else if (rating === 'up') errors.push({ path: 'reason', code: 'range' });
    else if (rating === 'down') reason = found;
  }
  if (errors.length > 0 || rating === undefined) return { ok: false, error: errors };
  return { ok: true, value: { rating, reason } };
}
