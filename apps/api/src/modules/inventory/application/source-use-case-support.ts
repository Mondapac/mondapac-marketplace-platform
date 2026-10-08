import { err, parseId, type CallContext, type Id, type Result } from '@mondapac/shared-kernel';
import {
  parseSourceAddress,
  parseSourceName,
  parseSourceTimeZone,
  type SourceAddress,
} from '../domain/source-text';

/** The shape of a refused input: codes and paths only, never the text (personal data). */
export type ValidationFailed = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export type SellerNotReady = { readonly code: 'inventory.not-ready' };

export const STALE = Object.freeze({ code: 'conflict.stale' as const });
export const NOT_READY: SellerNotReady = Object.freeze({ code: 'inventory.not-ready' as const });

/** The acting seller of a seller-scope call, or null: a seller key admits a seller only. */
export function sellerOf(context: CallContext): Id<'Seller'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  return actor.sellerId;
}

/** `expectedVersion`: a whole number of 1 or more. */
export function checkVersion(raw: unknown, fields: { path: string; code: string }[]): number {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1) return raw;
  fields.push({ path: 'expectedVersion', code: 'format' });
  return 0;
}

export function checkSourceId(
  raw: unknown,
  path: string,
  fields: { path: string; code: string }[],
): Id<'InventorySource'> | null {
  const id = typeof raw === 'string' ? parseId<'InventorySource'>(raw) : null;
  if (id?.ok === true) return id.value;
  fields.push({ path, code: 'format' });
  return null;
}

/** Name, address (object or null) and zone (string or null) of D12, checked with codes only. */
export function checkSourceBody(
  input: { readonly name: unknown; readonly address: unknown; readonly timeZone: unknown },
  fields: { path: string; code: string }[],
): { name: string; address: SourceAddress | null; timeZone: string | null } | null {
  const before = fields.length;
  const name = parseSourceName(input?.name);
  if (!name.ok) fields.push({ path: 'name', code: name.error.rule });
  let address: SourceAddress | null = null;
  if (input?.address !== null && input?.address !== undefined) {
    const parsed = parseSourceAddress(input.address);
    if (parsed.ok) address = parsed.value;
    else {
      const path = 'field' in parsed.error ? `address.${parsed.error.field}` : 'address';
      fields.push({ path, code: parsed.error.rule });
    }
  }
  let timeZone: string | null = null;
  if (input?.timeZone !== null && input?.timeZone !== undefined) {
    const parsed = parseSourceTimeZone(input.timeZone);
    if (parsed.ok) timeZone = parsed.value;
    else fields.push({ path: 'timeZone', code: 'unknown' });
  }
  if (fields.length > before || !name.ok) return null;
  return { name: name.value, address, timeZone };
}

export const validationFailed = (
  fields: readonly { path: string; code: string }[],
): Result<never, ValidationFailed> => err({ code: 'validation.failed', fields });
