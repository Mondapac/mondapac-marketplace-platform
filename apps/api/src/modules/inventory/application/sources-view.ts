import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { SellerInventory } from '../domain/seller-inventory';
import type { SourceAddress } from '../domain/source-text';

/** One stock location as the seller's screen shows it. **Personal data** in name and address. */
export interface SourceView {
  readonly id: Id<'InventorySource'>;
  readonly name: string;
  readonly isDefault: boolean;
  /** 1..n, the seller's order. */
  readonly position: number;
  readonly address: SourceAddress | null;
  readonly timeZone: string | null;
  readonly createdAt: Temporal.Instant;
}

/**
 * The seller's locations in priority order, with the version the screen sends back on the next
 * change (`expectedVersion`) and the Market's limit (UX F29: "{count} of {max} used").
 */
export interface SourcesView {
  readonly version: number;
  readonly max: number;
  readonly sources: readonly SourceView[];
}

export function sourcesViewOf(inventory: SellerInventory, max: number): SourcesView {
  const state = inventory.state;
  return {
    version: state.version,
    max,
    sources: state.sources.map((source) => ({
      id: source.id,
      name: source.name,
      isDefault: source.isDefault,
      position: source.priority,
      address: source.address,
      timeZone: source.timeZone,
      createdAt: source.createdAt,
    })),
  };
}
