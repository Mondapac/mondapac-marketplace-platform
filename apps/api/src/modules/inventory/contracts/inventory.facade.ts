import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** At most this many keys per batch call; a larger call is refused whole. */
export const MAX_AVAILABILITY_BATCH = 200;

export interface SellUnitKey {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/** The map key of a {@link SellUnitKey}. */
export function sellUnitKeyOf(key: SellUnitKey): string {
  return `${key.offerId}/${key.variantId}`;
}

/**
 * What can be bought now. `sellable` is the exact count for the cart's quantity check and must
 * never be shown to a buyer; the public statement is `status` plus `onlyLeft` (set for `low`).
 */
export interface SellUnitAvailability {
  readonly sellable: number;
  readonly status: 'in-stock' | 'low' | 'out';
  readonly onlyLeft: number | null;
}

/** Per requested key. A key with no stock is present with `sellable: 0` and status `out`. */
export type AvailabilityMap = ReadonlyMap<string, SellUnitAvailability>;

export interface InventoryValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export interface InventoryBatchTooLarge {
  readonly code: 'batch.too-large';
}

/** The public facade of `inventory`. Takes the caller's `CallContext` unchanged; advisory. */
export interface InventoryFacade {
  availability(
    context: CallContext,
    keys: readonly SellUnitKey[],
  ): Promise<
    Result<AvailabilityMap, AccessDenied | InventoryValidationFailed | InventoryBatchTooLarge>
  >;
}

/** Nest token of the {@link InventoryFacade}, provided and exported by `InventoryModule`. */
export const INVENTORY_FACADE = Symbol('INVENTORY_FACADE');
