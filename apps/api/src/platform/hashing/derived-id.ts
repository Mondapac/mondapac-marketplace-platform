import { createHash } from 'node:crypto';
import { parseId, type Id } from '@mondapac/shared-kernel';

/**
 * A stable id derived from another id, for an aggregate that has no row of its own to take an id
 * from (for example a store profile's outbox events, which must not share the seller id: the
 * outbox key (market, aggregate id, aggregate version) is unique). The platform accepts only
 * canonical version 7 ids as aggregate ids, so the result keeps the source id's 48-bit time
 * prefix and takes the other bits from SHA-256 over `namespace` and the source id: a
 * deterministic, name-based id in the version 7 layout. `namespace` names the use and is never
 * changed once events exist (changing it gives every aggregate a new id).
 */
export function derivedId<K extends string>(namespace: string, source: Id): Id<K> {
  const digest = createHash('sha256').update(namespace).update('\0').update(source).digest();
  const prefix = Buffer.from(source.replaceAll('-', '').slice(0, 12), 'hex');
  const bytes = Buffer.concat([prefix, digest.subarray(0, 10)]);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const parsed = parseId<K>(text);
  if (!parsed.ok) throw new RangeError('derivedId: the source id is not a version 7 id');
  return parsed.value;
}
