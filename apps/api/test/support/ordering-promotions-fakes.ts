import { encodePayload, err, ok, type Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import { ORDERING_EVENTS } from '../../src/modules/ordering/domain/events';
import type {
  PromotionsFacade,
  PromotionsFacadeFailure,
  QuoteLine,
  QuoteRequest,
  QuoteResult,
  QuoteShipping,
  RedeemFacadeFailure,
  RedeemRequest,
  RedeemResult,
  RedemptionSettlement,
  RedemptionSweepFailure,
} from '../../src/modules/promotions';
import type { OrderProducts } from '../../src/modules/ordering/application/ports/order-products';

/** The product of each Offer as checkout reads it from catalog: `product-<offer>` unless set. */
export class FakeOrderProducts implements OrderProducts {
  readonly byOffer = new Map<Id<'Offer'>, Id<'Product'>>();
  readonly unknown = new Set<Id<'Offer'>>();
  fail = false;

  productsOf(
    _context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, Id<'Product'>>> {
    if (this.fail) return Promise.reject(new Error('products'));
    return Promise.resolve(
      new Map(
        offerIds
          .filter((id) => !this.unknown.has(id))
          .map((id) => [id, this.byOffer.get(id) ?? (id as unknown as Id<'Product'>)] as const),
      ),
    );
  }
}

/** One discount the fake gives a line: the seller's and the platform's shares of it. */
export interface FakeLineDiscount {
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
}

/**
 * A {@link PromotionsFacade} for ordering's tests. With nothing set it gives no discount (the
 * Market switch off). `lineDiscount` and `shippingDiscount` give discounts; the platform's share of
 * the goods discounts is capped by the request's commission, as promotions caps it. `codes` are the
 * codes that apply. Every request is kept; `redeemAnswers` answers the redemptions in turn.
 */
export class FakePromotions implements PromotionsFacade {
  readonly quotes: { context: CallContext; request: QuoteRequest }[] = [];
  readonly redeems: { context: CallContext; request: RedeemRequest }[] = [];
  lineDiscount: (line: QuoteLine) => FakeLineDiscount | null = () => null;
  shippingDiscount: (charge: QuoteShipping) => bigint = () => 0n;
  readonly codes = new Set<string>();
  quoteFailure: PromotionsFacadeFailure | null = null;
  readonly redeemAnswers: Result<RedeemResult, RedeemFacadeFailure>[] = [];

  quote(
    context: CallContext,
    request: QuoteRequest,
  ): Promise<Result<QuoteResult, PromotionsFacadeFailure>> {
    this.quotes.push({ context, request });
    if (this.quoteFailure !== null) return Promise.resolve(err(this.quoteFailure));
    return Promise.resolve(ok(this.calculate(request)));
  }

  redeem(
    context: CallContext,
    request: RedeemRequest,
  ): Promise<Result<RedeemResult, RedeemFacadeFailure>> {
    this.redeems.push({ context, request });
    return Promise.resolve(this.redeemAnswers.shift() ?? ok({ outcome: 'redeemed' as const }));
  }

  /** The orders the sweep is told hold stale RESERVED redemptions. */
  readonly stale: Id<'Order'>[] = [];
  readonly staleRequests: { before: Temporal.Instant; limit: number; after?: Id<'Order'> }[] = [];
  readonly settlements: { orderId: Id<'Order'>; outcome: RedemptionSettlement }[] = [];

  staleRedemptions(
    _context: CallContext,
    request: {
      readonly before: Temporal.Instant;
      readonly limit: number;
      readonly after?: Id<'Order'>;
    },
  ): Promise<Result<readonly Id<'Order'>[], RedemptionSweepFailure>> {
    this.staleRequests.push({ ...request });
    const { after } = request;
    const ids = [...this.stale].sort().filter((id) => after === undefined || id > after);
    return Promise.resolve(ok(ids.slice(0, request.limit)));
  }

  settleRedemptions(
    _context: CallContext,
    request: { readonly orderId: Id<'Order'>; readonly outcome: RedemptionSettlement },
  ): Promise<
    Result<
      { readonly outcome: 'confirmed' | 'released' | 'nothing' | 'already-handled' },
      RedemptionSweepFailure
    >
  > {
    this.settlements.push({ ...request });
    return Promise.resolve(
      ok({ outcome: request.outcome === 'paid' ? ('confirmed' as const) : ('released' as const) }),
    );
  }

  wasPriceEligible(): Promise<Result<{ readonly eligible: boolean }, PromotionsFacadeFailure>> {
    return Promise.resolve(ok({ eligible: false }));
  }

  /** The discounted cart, as promotions would answer it. */
  calculate(request: QuoteRequest): QuoteResult {
    const currency = request.orderCommission.currency;
    const codeApplies = request.code !== null && this.codes.has(request.code);
    let platformLeft = request.orderCommission.amount;
    const lines = request.lines.map((line) => {
      const gross = line.unitPrice.amount * BigInt(line.quantity);
      const wanted = this.lineDiscount(line);
      const sellerShare = wanted?.sellerShare ?? 0n;
      const platformShare =
        wanted === null
          ? 0n
          : wanted.platformShare < platformLeft
            ? wanted.platformShare
            : platformLeft;
      platformLeft -= platformShare;
      const discount = sellerShare + platformShare;
      return {
        lineId: line.id,
        gross,
        discount,
        net: gross - discount,
        allocations:
          discount === 0n
            ? []
            : [
                {
                  promotionId: 'promotion-1',
                  layer: 'ITEM' as const,
                  amount: discount,
                  sellerShare,
                  platformShare,
                },
              ],
      };
    });
    const shipping = request.shipping.map((charge) => {
      const discount = this.shippingDiscount(charge);
      return {
        shippingId: charge.id,
        gross: charge.amount.amount,
        discount,
        net: charge.amount.amount - discount,
        allocations:
          discount === 0n
            ? []
            : [
                {
                  promotionId: 'free-shipping',
                  layer: 'SHIPPING' as const,
                  amount: discount,
                  sellerShare: 0n,
                  platformShare: discount,
                },
              ],
      };
    });
    const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n);
    const goodsDiscount = sum(lines.map((l) => l.discount));
    const sellerShare = sum(lines.flatMap((l) => l.allocations.map((a) => a.sellerShare)));
    const platformShare = sum(lines.flatMap((l) => l.allocations.map((a) => a.platformShare)));
    const shippingDiscount = sum(shipping.map((s) => s.discount));
    const goodsGross = sum(lines.map((l) => l.gross));
    const shippingGross = sum(shipping.map((s) => s.gross));
    const applied = [
      ...(goodsDiscount > 0n
        ? [
            {
              promotionId: 'promotion-1',
              layer: 'ITEM' as const,
              amount: goodsDiscount,
              sellerShare,
              platformShare,
            },
          ]
        : []),
      ...(shippingDiscount > 0n
        ? [
            {
              promotionId: 'free-shipping',
              layer: 'SHIPPING' as const,
              amount: shippingDiscount,
              sellerShare: 0n,
              platformShare: shippingDiscount,
            },
          ]
        : []),
    ];
    return {
      currency,
      lines,
      shipping,
      applied,
      code: request.code === null ? 'NONE' : codeApplies ? 'APPLIED' : 'NOT_APPLIED',
      totals: {
        goodsGross,
        goodsDiscount,
        goodsNet: goodsGross - goodsDiscount,
        sellerShare,
        platformShare,
        shippingGross,
        shippingDiscount,
        shippingNet: shippingGross - shippingDiscount,
        payable: goodsGross - goodsDiscount + shippingGross - shippingDiscount,
      },
      enabled: true,
    };
  }
}

const NO_KEYS = { isKnownPermissionKey: () => false };

/** Collects ordering's events, each checked against its catalogue definition as the writer does. */
export class RecordingOrderingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = ORDERING_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, NO_KEYS);
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}
