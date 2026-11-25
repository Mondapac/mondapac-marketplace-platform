import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { OFFER_REVIEW_REASONS, type OfferReviewReason } from '../../domain/offer-review-policy';
import type { ValidationFailure } from '../own-reads/own-reads.shared';

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The `reasons` filter of the Offer review lists (held edits and first publications): an array of
 * review reason codes or one comma-separated text, each a known reason; rows that carry any of
 * them. Null when absent. Duplicates are kept once, in the order given.
 */
export function parseOfferReviewReasons(
  value: unknown,
): Result<readonly OfferReviewReason[] | null, ValidationFailure> {
  if (absent(value)) return ok(null);
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? (value as unknown[])
        : null;
  if (raw === null || raw.length === 0 || raw.length > OFFER_REVIEW_REASONS.length * 2) {
    return err({ code: 'validation.failed', fields: [{ path: 'reasons', code: 'type' }] });
  }
  const picked = new Set<OfferReviewReason>();
  for (const item of raw) {
    const known = OFFER_REVIEW_REASONS.find((reason) => reason === item);
    if (known === undefined) {
      return err({ code: 'validation.failed', fields: [{ path: 'reasons', code: 'value' }] });
    }
    picked.add(known);
  }
  return ok([...picked]);
}
