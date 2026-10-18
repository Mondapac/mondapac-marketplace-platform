import type { MarketContext } from '@mondapac/shared-kernel';
import type { AddressFormat } from '../../domain/address';

/** The Market's address book settings; null when the Market has none (fail closed). */
export interface AddressPolicy {
  settings(
    market: MarketContext,
  ): { readonly limit: number; readonly format: AddressFormat } | null;
}

export const ADDRESS_POLICY = Symbol('ADDRESS_POLICY');
