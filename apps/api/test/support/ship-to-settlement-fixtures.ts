import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { OrderStatus } from '../../src/modules/ordering/domain/order';
import type { RefundState } from '../../src/modules/ordering/domain/refund';
import type { ShipToSettlementFacts } from '../../src/modules/ordering/domain/ship-to-retention';

// The order shapes of the ship-to purge rule (owner decision 2026-11-15, 03:42Z), written once and
// used by the domain spec, the in-memory repository, the use-case spec and the database spec, so
// the rule in code and the repository's query are checked on the same cases. Every seller order
// has one line of LINE_QUANTITY units; a refund gives back `units` of it.

export const LINE_QUANTITY = 2;

export interface RefundSpec {
  readonly at: Temporal.Instant;
  readonly units: number;
  readonly state?: RefundState;
}

export type SellerOrderSpec =
  | { readonly kind: 'delivered'; readonly at: Temporal.Instant }
  | { readonly kind: 'shipped'; readonly at: Temporal.Instant }
  | { readonly kind: 'to-ship'; readonly refunds?: readonly RefundSpec[] };

export interface OrderSpec {
  /** Confirmed unless said; a cancelled order needs `cancelledAt`. */
  readonly status?: OrderStatus;
  readonly cancelledAt?: Temporal.Instant;
  readonly sellerOrders: readonly SellerOrderSpec[];
}

const lineId = (order: number, sellerOrder: number) =>
  `01990000-0000-7000-8000-${(order * 100 + sellerOrder).toString(16).padStart(12, '0')}` as Id<'OrderLine'>;

/** The facts `isShipToPurgeable` reads of an order spec (line ids are made up per position). */
export function settlementFacts(spec: OrderSpec, orderIndex = 0): ShipToSettlementFacts {
  return {
    status: spec.status ?? 'confirmed',
    cancelledAt: spec.cancelledAt ?? null,
    sellerOrders: spec.sellerOrders.map((so, index) => {
      const line = lineId(orderIndex, index);
      return {
        fulfilment: so.kind,
        shippedAt: so.kind === 'to-ship' ? null : so.at,
        deliveredAt: so.kind === 'delivered' ? so.at : null,
        lines: [{ lineId: line, quantity: LINE_QUANTITY }],
        refunds: (so.kind === 'to-ship' ? (so.refunds ?? []) : []).map((refund) => ({
          state: refund.state ?? 'succeeded',
          requestedAt: refund.at,
          lines: [{ orderLineId: line, quantity: refund.units }],
        })),
      };
    }),
  };
}

/**
 * The cases around `cutoff`, each with the answer the owner's rule gives. `ms` moves an instant
 * by milliseconds from the cutoff; the database keeps milliseconds, so the boundaries are exact.
 */
export function settlementCases(
  cutoff: Temporal.Instant,
): readonly { readonly name: string; readonly spec: OrderSpec; readonly purgeable: boolean }[] {
  const ms = (n: number) => cutoff.add({ milliseconds: n });
  const old = cutoff.subtract({ hours: 24 * 400 });
  return [
    {
      name: 'delivered at the cutoff',
      spec: { sellerOrders: [{ kind: 'delivered', at: ms(0) }] },
      purgeable: true,
    },
    {
      name: 'delivered 1 ms after',
      spec: { sellerOrders: [{ kind: 'delivered', at: ms(1) }] },
      purgeable: false,
    },
    {
      name: 'shipped, never delivered, at the cutoff',
      spec: { sellerOrders: [{ kind: 'shipped', at: ms(0) }] },
      purgeable: true,
    },
    {
      name: 'shipped, never delivered, 1 ms after',
      spec: { sellerOrders: [{ kind: 'shipped', at: ms(1) }] },
      purgeable: false,
    },
    {
      name: 'cancelled at the cutoff',
      spec: { status: 'cancelled', cancelledAt: ms(0), sellerOrders: [{ kind: 'to-ship' }] },
      purgeable: true,
    },
    {
      name: 'cancelled 1 ms after',
      spec: { status: 'cancelled', cancelledAt: ms(1), sellerOrders: [{ kind: 'to-ship' }] },
      purgeable: false,
    },
    {
      name: 'refunded in full while to ship, completed at the cutoff',
      spec: {
        sellerOrders: [
          {
            kind: 'to-ship',
            refunds: [
              { at: old, units: 1 },
              { at: ms(0), units: 1 },
            ],
          },
        ],
      },
      purgeable: true,
    },
    {
      name: 'refunded in full while to ship, completed 1 ms after',
      spec: {
        sellerOrders: [
          {
            kind: 'to-ship',
            refunds: [
              { at: old, units: 1 },
              { at: ms(1), units: 1 },
            ],
          },
        ],
      },
      purgeable: false,
    },
    {
      name: 'refunded in full by a pending refund (not failed counts)',
      spec: {
        sellerOrders: [{ kind: 'to-ship', refunds: [{ at: old, units: 2, state: 'pending' }] }],
      },
      purgeable: true,
    },
    {
      name: 'refunded in part only',
      spec: { sellerOrders: [{ kind: 'to-ship', refunds: [{ at: old, units: 1 }] }] },
      purgeable: false,
    },
    {
      name: 'refunded in full only by counting a failed refund',
      spec: {
        sellerOrders: [
          {
            kind: 'to-ship',
            refunds: [
              { at: old, units: 1 },
              { at: old, units: 1, state: 'failed' },
            ],
          },
        ],
      },
      purgeable: false,
    },
    {
      name: 'to ship, nothing refunded',
      spec: { sellerOrders: [{ kind: 'to-ship' }] },
      purgeable: false,
    },
    {
      name: 'mixed, all settled long ago',
      spec: {
        sellerOrders: [
          { kind: 'delivered', at: old },
          { kind: 'shipped', at: old },
          { kind: 'to-ship', refunds: [{ at: old, units: 2 }] },
        ],
      },
      purgeable: true,
    },
    {
      name: 'mixed, one seller order not settled',
      spec: { sellerOrders: [{ kind: 'delivered', at: old }, { kind: 'to-ship' }] },
      purgeable: false,
    },
    {
      name: 'mixed, the latest settled 1 ms after the cutoff',
      spec: {
        sellerOrders: [
          { kind: 'delivered', at: old },
          { kind: 'shipped', at: ms(1) },
        ],
      },
      purgeable: false,
    },
  ];
}
