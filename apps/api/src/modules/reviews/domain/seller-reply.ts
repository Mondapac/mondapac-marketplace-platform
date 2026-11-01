import { parsePlainText, Temporal } from '@mondapac/shared-kernel';
import { isWithinEditWindow, type FieldProblem, type Validated } from './rules';

// The pure rules of the seller's side of reviews (buyer reviews and ratings package 4; owner
// decision N6 and design section 5.2). One public reply per review, editable for a Market-set
// number of days (the design proposes 7). The seller never hides or removes a review: it can only
// report it, with a reason from a closed list. No number here is a Market's: lengths and windows
// are passed in from Market config.

export const SELLER_REPORT_REASONS = [
  'personal-info',
  'abusive',
  'irrelevant',
  'not-a-buyer',
  'extortion',
] as const;
export type SellerReportReason = (typeof SELLER_REPORT_REASONS)[number];

export const REPLY_STATUSES = ['published', 'hidden', 'removed'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export interface ReplyLimits {
  readonly bodyMaxLength: number;
}

const lengthOf = (text: string): number => Array.from(text).length;

/** A reply's text as the seller sends it: required, plain text, within the Market's length. */
export function validateReplyInput(input: unknown, limits: ReplyLimits): Validated<string> {
  const source =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const problems: FieldProblem[] = [];
  const raw = source.body;
  let body = '';
  if (typeof raw !== 'string') problems.push({ path: 'body', code: 'type' });
  else {
    body = raw.trim();
    if (body === '') problems.push({ path: 'body', code: 'required' });
    else if (!parsePlainText(body).ok) problems.push({ path: 'body', code: 'invisible-character' });
    else if (lengthOf(body) > limits.bodyMaxLength) problems.push({ path: 'body', code: 'length' });
  }
  return problems.length > 0 ? { ok: false, error: problems } : { ok: true, value: body };
}

/** A report's reason as the seller sends it: one code of the closed list (never free text). */
export function validateReportReason(input: unknown): Validated<SellerReportReason> {
  const reason =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>).reasonCode
      : undefined;
  return typeof reason === 'string' && (SELLER_REPORT_REASONS as readonly string[]).includes(reason)
    ? { ok: true, value: reason as SellerReportReason }
    : { ok: false, error: [{ path: 'reasonCode', code: 'unknown' }] };
}

/** Whether the seller may still edit its reply: `days` days after it was first written. */
export const canEditReply = (
  createdAt: Temporal.Instant,
  now: Temporal.Instant,
  days: number,
): boolean => isWithinEditWindow(createdAt, now, days);

/**
 * A reply can only be written for a review the public can see, and only while its status is
 * `published`: a held, hidden, removed or deleted review takes no reply.
 */
export const canReplyToStatus = (status: string): boolean => status === 'published';
