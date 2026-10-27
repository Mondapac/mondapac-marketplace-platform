import { parsePlainText, Temporal } from '@mondapac/shared-kernel';

// The pure rules of reviews (buyer reviews and ratings package 1; owner decisions N2, N4). No
// number here is a Market's: the windows and the length limits come from Market config
// (`reviews`) and are passed in. Time is only ever added to an instant given by the caller (the
// injected Clock reads "now"); a window is a fixed number of 24-hour days, not a calendar span.

export const REVIEW_STATUSES = [
  'published',
  'held',
  'hidden',
  'removed',
  'deleted-by-author',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** A seller rating is text-free, so it has no `held` or author-delete state. */
export const SELLER_RATING_STATUSES = ['published', 'hidden', 'removed'] as const;
export type SellerRatingStatus = (typeof SELLER_RATING_STATUSES)[number];

export const SELLER_RATING_REASONS = ['damaged', 'missing-items', 'temperature', 'other'] as const;
export type SellerRatingReason = (typeof SELLER_RATING_REASONS)[number];

/** Whether a review in this status is shown to the public. */
export const isPublic = (status: ReviewStatus): boolean => status === 'published';

/** The author may still change a review that is live (published) or waiting for a human (held). */
export const isEditableStatus = (status: ReviewStatus): boolean =>
  status === 'published' || status === 'held';

const HOURS_PER_DAY = 24;

/** When a window of `days` days that opened at `from` closes. */
export function windowEndsAt(from: Temporal.Instant, days: number): Temporal.Instant {
  return from.add({ hours: days * HOURS_PER_DAY });
}

/**
 * Whether a buyer may still review or rate: from the delivery instant to `days` days after it,
 * both ends included (N4).
 */
export function isWithinReviewWindow(
  deliveredAt: Temporal.Instant,
  now: Temporal.Instant,
  days: number,
): boolean {
  return (
    Temporal.Instant.compare(now, deliveredAt) >= 0 &&
    Temporal.Instant.compare(now, windowEndsAt(deliveredAt, days)) <= 0
  );
}

/** Whether the author may still edit: up to `days` days after the first submit (N4). */
export function isWithinEditWindow(
  firstSubmittedAt: Temporal.Instant,
  now: Temporal.Instant,
  days: number,
): boolean {
  return Temporal.Instant.compare(now, windowEndsAt(firstSubmittedAt, days)) <= 0;
}

export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

export interface TextLimits {
  readonly titleMaxLength: number;
  readonly bodyMaxLength: number;
}

export interface ProductReviewContent {
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly anonymous: boolean;
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: readonly FieldProblem[] };

const isStar = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;

/** Characters, as a person counts them (code points), not UTF-16 units or bytes. */
const lengthOf = (text: string): number => Array.from(text).length;

function optionalText(
  input: Record<string, unknown>,
  key: 'title' | 'body',
  max: number,
  problems: FieldProblem[],
): string | null {
  const raw = input[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    problems.push({ path: key, code: 'type' });
    return null;
  }
  const text = raw.trim();
  if (text === '') return null;
  if (!parsePlainText(text).ok) {
    problems.push({ path: key, code: 'invisible-character' });
    return null;
  }
  if (lengthOf(text) > max) {
    problems.push({ path: key, code: 'length' });
    return null;
  }
  return text;
}

const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/** A product review's content as the buyer sends it: rating (required), title, body, anonymous. */
export function validateProductReviewInput(
  input: unknown,
  limits: TextLimits,
): Validated<ProductReviewContent> {
  const source = asRecord(input);
  const problems: FieldProblem[] = [];
  if (!isStar(source.rating)) problems.push({ path: 'rating', code: 'range' });
  const title = optionalText(source, 'title', limits.titleMaxLength, problems);
  const body = optionalText(source, 'body', limits.bodyMaxLength, problems);
  let anonymous = false;
  if (source.anonymous !== undefined) {
    if (typeof source.anonymous === 'boolean') anonymous = source.anonymous;
    else problems.push({ path: 'anonymous', code: 'type' });
  }
  if (problems.length > 0) return { ok: false, error: problems };
  return { ok: true, value: { rating: source.rating as number, title, body, anonymous } };
}

export interface SellerRatingContent {
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: SellerRatingReason | null;
}

/** A seller rating as the buyer sends it (N2): no question about timeliness, courier never rated. */
export function validateSellerRatingInput(input: unknown): Validated<SellerRatingContent> {
  const source = asRecord(input);
  const problems: FieldProblem[] = [];
  if (!isStar(source.satisfaction)) problems.push({ path: 'satisfaction', code: 'range' });
  if (typeof source.asDescribed !== 'boolean') problems.push({ path: 'asDescribed', code: 'type' });
  if (typeof source.arrivedOk !== 'boolean') problems.push({ path: 'arrivedOk', code: 'type' });
  let reasonCode: SellerRatingReason | null = null;
  const rawReason = source.reasonCode;
  if (rawReason !== undefined && rawReason !== null) {
    if (
      typeof rawReason !== 'string' ||
      !(SELLER_RATING_REASONS as readonly string[]).includes(rawReason)
    ) {
      problems.push({ path: 'reasonCode', code: 'value' });
    } else if (source.arrivedOk === true) {
      problems.push({ path: 'reasonCode', code: 'not-allowed' });
    } else {
      reasonCode = rawReason as SellerRatingReason;
    }
  }
  if (problems.length > 0) return { ok: false, error: problems };
  return {
    ok: true,
    value: {
      satisfaction: source.satisfaction as number,
      asDescribed: source.asDescribed as boolean,
      arrivedOk: source.arrivedOk as boolean,
      reasonCode,
    },
  };
}
