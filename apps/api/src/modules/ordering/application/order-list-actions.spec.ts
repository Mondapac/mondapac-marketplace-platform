import { rowActions } from '../../../platform/list-query';
import { adminOrderActionRules, SELLER_ORDER_ACTION_RULES } from './order-list-actions';

const ALL = new Set([
  'ordering.order.refund',
  'ordering.order.note',
  'ordering.seller-order.mark-ready',
  'ordering.seller-order.confirm-pickup',
  'ordering.seller-order.mark-delivered',
  'ordering.seller-order.mark-unavailable',
]);

const part = (fulfilment: 'to-ship' | 'shipped' | 'delivered', readyAt: unknown = null) => ({
  fulfilment,
  readyAt,
});
const paidOrder = (parts = [part('to-ship')]) => ({
  status: 'confirmed' as const,
  paymentState: 'captured' as const,
  confirmedAt: new Date(),
  sellerOrders: parts,
});

describe('admin order row actions', () => {
  it('offers refund and cancel on a paid order no seller has started, when refunds are on', () => {
    const rules = adminOrderActionRules(true);
    expect(rowActions(paidOrder(), rules, ALL)).toEqual([
      'open',
      'print-document',
      'copy-number',
      'add-note',
      'refund',
      'cancel',
    ]);
  });

  it('drops cancel once a seller marked the order ready or shipped it, keeping refund', () => {
    const rules = adminOrderActionRules(true);
    expect(rowActions(paidOrder([part('to-ship', new Date())]), rules, ALL)).not.toContain(
      'cancel',
    );
    const shipped = rowActions(paidOrder([part('shipped')]), rules, ALL);
    expect(shipped).toContain('refund');
    expect(shipped).not.toContain('cancel');
  });

  it('never offers money actions while the Market switch is off or without the refund key', () => {
    expect(rowActions(paidOrder(), adminOrderActionRules(false), ALL)).toEqual([
      'open',
      'print-document',
      'copy-number',
      'add-note',
    ]);
    const noKeys = rowActions(paidOrder(), adminOrderActionRules(true), new Set());
    expect(noKeys).toEqual(['open', 'print-document', 'copy-number']);
  });

  it('offers no document and no money action on an unpaid or cancelled order', () => {
    const pending = {
      status: 'pending-payment' as const,
      paymentState: 'none' as const,
      confirmedAt: null,
      sellerOrders: [part('to-ship')],
    };
    expect(rowActions(pending, adminOrderActionRules(true), ALL)).toEqual([
      'open',
      'copy-number',
      'add-note',
    ]);
  });
});

describe('seller order row actions', () => {
  const row = (
    fulfilment: 'to-ship' | 'shipped' | 'delivered',
    deliveryMethod: string,
    readyAt: unknown = null,
    cancelledAt: unknown = null,
  ) => ({ fulfilment, deliveryMethod, readyAt, cancelledAt }) as never;

  it('offers ready and report-unavailable before the order is ready', () => {
    expect(rowActions(row('to-ship', 'standard'), SELLER_ORDER_ACTION_RULES, ALL)).toEqual([
      'open',
      'packing-slip',
      'copy-number',
      'ready',
      'report-unavailable',
    ]);
  });

  it('offers neither ready nor report-unavailable once an admin cancelled the order (BUG-017)', () => {
    expect(
      rowActions(row('to-ship', 'standard', null, new Date()), SELLER_ORDER_ACTION_RULES, ALL),
    ).toEqual(['open', 'packing-slip', 'copy-number']);
  });

  it('offers hand-over only for a ready pickup order', () => {
    const ready = new Date();
    expect(rowActions(row('to-ship', 'pickup', ready), SELLER_ORDER_ACTION_RULES, ALL)).toContain(
      'hand-over',
    );
    expect(
      rowActions(row('to-ship', 'standard', ready), SELLER_ORDER_ACTION_RULES, ALL),
    ).not.toContain('hand-over');
    expect(rowActions(row('to-ship', 'pickup'), SELLER_ORDER_ACTION_RULES, ALL)).not.toContain(
      'hand-over',
    );
  });

  it('offers mark-delivered for a shipped order and nothing to change on a delivered one', () => {
    expect(rowActions(row('shipped', 'standard'), SELLER_ORDER_ACTION_RULES, ALL)).toEqual([
      'open',
      'packing-slip',
      'copy-number',
      'mark-delivered',
    ]);
    expect(rowActions(row('delivered', 'standard'), SELLER_ORDER_ACTION_RULES, ALL)).toEqual([
      'open',
      'packing-slip',
      'copy-number',
    ]);
  });

  it('leaves out an action whose key the caller does not hold', () => {
    expect(rowActions(row('to-ship', 'standard'), SELLER_ORDER_ACTION_RULES, new Set())).toEqual([
      'open',
      'packing-slip',
      'copy-number',
    ]);
  });
});
