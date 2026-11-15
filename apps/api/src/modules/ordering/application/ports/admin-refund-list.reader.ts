import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  RefundListFilter,
  RefundListRecord,
  RefundSort,
  RefundStateCounts,
} from '../../domain/admin-refund-list';

export const ADMIN_REFUND_LIST_READER = Symbol('ADMIN_REFUND_LIST_READER');

/**
 * The read side of the admin Refunds list (ordering.refunds with its order and credit note). Every
 * method runs in the open read unit of the use case, through the Market-scoped client, and only
 * ever sees the Market's own rows.
 */
export interface AdminRefundListReader {
  /** One page of the refunds matching the filter, in the sort's order (ties by id). */
  page(
    market: MarketContext,
    filter: RefundListFilter,
    sort: RefundSort,
    offset: number,
    limit: number,
  ): Promise<readonly RefundListRecord[]>;
  /** How many refunds match the filter. */
  count(market: MarketContext, filter: RefundListFilter): Promise<number>;
  /** The Market's refunds per state, whatever the filter. */
  countByState(market: MarketContext): Promise<RefundStateCounts>;
}
