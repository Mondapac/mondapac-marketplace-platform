import type { RowActionRule } from '../../../platform/list-query';
import {
  ORDERING_ORDER_NOTE,
  ORDERING_ORDER_REFUND,
  ORDERING_SELLER_ORDER_CONFIRM_PICKUP,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_MARK_READY,
  ORDERING_SELLER_ORDER_MARK_UNAVAILABLE,
} from '../contracts/permissions';
import type { AdminOrderPageView, SellerOrderDetailView } from '../domain/order-views';

// The row Actions menu of the order lists (super list phase 1, B1-1): which actions each row
// offers to the caller, from the caller's keys and the row's state. The menu only names what the
// server will honour; every action checks its own key again when it runs.

type AdminOrderRowState = Pick<AdminOrderPageView['orders'][number], 'status' | 'paymentState'> & {
  readonly confirmedAt: unknown;
  readonly sellerOrders: readonly {
    readonly fulfilment: 'to-ship' | 'shipped' | 'delivered';
    readonly readyAt: unknown;
  }[];
};

/** Context the rules need besides the row: whether the Market lets refunds run at all. */
export interface AdminOrderActionContext {
  readonly refundsEnabled: boolean;
}

/**
 * Admin Orders row actions. `open`, `print-document` and `copy-number` are safe reads (the list's
 * own key suffices). `add-note` needs the note key. `refund` and `cancel` give money back, so they
 * need the protected refund key and are offered only while the Market's refund switch is on:
 * `refund` on a paid order, `cancel` while no seller has started on it (the rule of the cancel
 * use case, which checks it again).
 */
export function adminOrderActionRules(
  refundsEnabled: boolean,
): readonly RowActionRule<AdminOrderRowState>[] {
  const paid = (row: AdminOrderRowState): boolean => row.status === 'confirmed';
  return [
    { id: 'open', permission: null },
    { id: 'print-document', permission: null, when: paid },
    { id: 'copy-number', permission: null },
    { id: 'add-note', permission: ORDERING_ORDER_NOTE.key },
    {
      id: 'refund',
      permission: ORDERING_ORDER_REFUND.key,
      when: (row) => refundsEnabled && paid(row) && row.paymentState === 'captured',
    },
    {
      id: 'cancel',
      permission: ORDERING_ORDER_REFUND.key,
      when: (row) =>
        refundsEnabled &&
        paid(row) &&
        row.paymentState === 'captured' &&
        row.sellerOrders.every((part) => part.fulfilment === 'to-ship' && part.readyAt === null),
    },
  ];
}

type SellerOrderRowState = Pick<SellerOrderDetailView, 'fulfilment' | 'deliveryMethod'> & {
  readonly readyAt: unknown;
  /** Set when an admin cancelled the order: nothing is left to prepare or report. */
  readonly cancelledAt: unknown;
};

/**
 * Seller Orders row actions: `open`, `packing-slip` (the slip of a paid order) and `copy-number`
 * are safe reads. `ready` while the order waits to be marked ready; `hand-over` for a ready
 * pickup order (the buyer's code is typed in its dialog); `mark-delivered` for a shipped one;
 * `report-unavailable` (protected, gives money back) before the order is ready.
 */
export const SELLER_ORDER_ACTION_RULES: readonly RowActionRule<SellerOrderRowState>[] = [
  { id: 'open', permission: null },
  { id: 'packing-slip', permission: null },
  { id: 'copy-number', permission: null },
  {
    id: 'ready',
    permission: ORDERING_SELLER_ORDER_MARK_READY.key,
    when: (row) => row.fulfilment === 'to-ship' && row.readyAt === null && row.cancelledAt === null,
  },
  {
    id: 'hand-over',
    permission: ORDERING_SELLER_ORDER_CONFIRM_PICKUP.key,
    when: (row) =>
      row.deliveryMethod === 'pickup' && row.fulfilment === 'to-ship' && row.readyAt !== null,
  },
  {
    id: 'mark-delivered',
    permission: ORDERING_SELLER_ORDER_MARK_DELIVERED.key,
    when: (row) => row.fulfilment === 'shipped',
  },
  {
    id: 'report-unavailable',
    permission: ORDERING_SELLER_ORDER_MARK_UNAVAILABLE.key,
    when: (row) => row.fulfilment === 'to-ship' && row.readyAt === null && row.cancelledAt === null,
  },
];
