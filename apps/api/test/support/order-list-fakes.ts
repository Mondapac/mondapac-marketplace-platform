import type { UseCaseGate } from '../../src/platform/authz';
import type { OrderingDependencies } from '../../src/modules/ordering/application/checkout-flow';
import { AdminListOrders } from '../../src/modules/ordering/application/use-cases/admin-list-orders.use-case';
import { OrderNoteProbe } from '../../src/modules/ordering/application/use-cases/order-note-probe.use-case';
import { OrderRefundProbe } from '../../src/modules/ordering/application/use-cases/order-refund-probe.use-case';
import { SellerOrderConfirmPickupProbe } from '../../src/modules/ordering/application/use-cases/seller-order-confirm-pickup-probe.use-case';
import { SellerOrderMarkDeliveredProbe } from '../../src/modules/ordering/application/use-cases/seller-order-mark-delivered-probe.use-case';
import { SellerOrderMarkReadyProbe } from '../../src/modules/ordering/application/use-cases/seller-order-mark-ready-probe.use-case';
import { SellerOrderMarkUnavailableProbe } from '../../src/modules/ordering/application/use-cases/seller-order-mark-unavailable-probe.use-case';
import { SellerListOrders } from '../../src/modules/ordering/application/use-cases/seller-list-orders.use-case';

/** The admin Orders list wired with real probes over `gate`. */
export const adminListOrders = (gate: UseCaseGate, deps: OrderingDependencies): AdminListOrders =>
  new AdminListOrders(gate, deps, {
    refundProbe: new OrderRefundProbe(gate),
    noteProbe: new OrderNoteProbe(gate),
  });

/** The seller Orders list wired with real probes over `gate`. */
export const sellerListOrders = (gate: UseCaseGate, deps: OrderingDependencies): SellerListOrders =>
  new SellerListOrders(gate, deps, {
    markReadyProbe: new SellerOrderMarkReadyProbe(gate),
    confirmPickupProbe: new SellerOrderConfirmPickupProbe(gate),
    markDeliveredProbe: new SellerOrderMarkDeliveredProbe(gate),
    markUnavailableProbe: new SellerOrderMarkUnavailableProbe(gate),
  });
