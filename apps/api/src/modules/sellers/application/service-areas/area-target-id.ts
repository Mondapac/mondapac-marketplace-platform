import { createHash } from 'node:crypto';
import { parseId, type Id, type MarketContext } from '@mondapac/shared-kernel';

/**
 * The audit target of a service area: an id derived from the Market and the area code, since an
 * area has no row and no id of its own (its code is configuration). Version 7 layout, as the audit
 * writer requires; the same Market and code always give the same id. The namespace is never
 * changed once rows exist.
 */
export function areaTargetId(market: MarketContext, areaCode: string): Id<'ServiceArea'> {
  const digest = createHash('sha256')
    .update('sellers.service-area')
    .update('\0')
    .update(market.marketId)
    .update('\0')
    .update(areaCode)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const parsed = parseId<'ServiceArea'>(text);
  if (!parsed.ok) throw new RangeError('areaTargetId: the derived id is not a version 7 id');
  return parsed.value;
}
