import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  ShipmentCursor,
  ShipmentListFilter,
  ShipmentListRecord,
  ShipmentSort,
  ShipmentStageCounts,
} from '../../domain/admin-shipment-list';

export const ADMIN_SHIPMENT_LIST_READER = Symbol('ADMIN_SHIPMENT_LIST_READER');

/**
 * The read side of the admin Shipments list: the seller orders of the Market's paid (confirmed)
 * orders. Every method runs in the open read unit of the use case, through the Market-scoped
 * client, and only ever sees the Market's own rows.
 */
export interface AdminShipmentListReader {
  /**
   * One page of the seller orders matching the filter, in the sort's order (ties by id). With
   * `after` (Previous/Next paging, newest payment first only) the page starts after that row.
   */
  page(
    market: MarketContext,
    filter: ShipmentListFilter,
    sort: ShipmentSort,
    offset: number,
    limit: number,
    after?: ShipmentCursor | null,
  ): Promise<readonly ShipmentListRecord[]>;
  count(market: MarketContext, filter: ShipmentListFilter): Promise<number>;
  /** The Market's shipments per stage, and those that need an admin, whatever the filter. */
  countByStage(market: MarketContext): Promise<ShipmentStageCounts>;
}
