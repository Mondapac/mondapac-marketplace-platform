import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

/** At most this many distinct seller ids per call. */
const MAX_IDS = 100;

export type SellerIdsFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { path: string; code: string }[];
};

/** Up to 100 seller ids, parsed, distinct, in first-occurrence order. */
export function sellerIdsOf(raw: unknown): Result<readonly Id<'Seller'>[], SellerIdsFailure> {
  if (!Array.isArray(raw) || raw.length > MAX_IDS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
  }
  const ids: Id<'Seller'>[] = [];
  for (const value of raw as unknown[]) {
    const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    if (!ids.includes(parsed.value)) ids.push(parsed.value);
  }
  return ok(ids);
}
