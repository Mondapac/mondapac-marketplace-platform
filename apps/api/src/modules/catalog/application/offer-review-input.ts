import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

export interface ReviewValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

const fail = (path: string, code: string): { ok: false; error: ReviewValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ReviewValidationFailure;
  };

/**
 * A reviewer's decision request: a closed body naming the Offer and the version the reviewer saw
 * (so a decision on a stale page is `conflict.stale`), plus the keys the caller allows.
 */
export function parseDecision(
  input: unknown,
  extraKeys: readonly string[],
): Result<
  { offerId: Id<'Offer'>; version: number; raw: Record<string, unknown> },
  ReviewValidationFailure
> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('body', 'type');
  }
  const raw = input as Record<string, unknown>;
  const allowed = ['offerId', 'version', ...extraKeys];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return fail(key, 'unknown');
  }
  const offer = typeof raw['offerId'] === 'string' ? parseId<'Offer'>(raw['offerId']) : null;
  if (offer === null || !offer.ok) return fail('offerId', 'format');
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail('version', 'type');
  }
  return ok({ offerId: offer.value, version, raw });
}
