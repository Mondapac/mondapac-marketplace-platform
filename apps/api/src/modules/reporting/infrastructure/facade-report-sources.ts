import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CatalogFacade } from '../../catalog';
import type {
  OrderingReportingFacade,
  ReportAmount,
  SellerOrderReportFacts,
  RefundReportFacts,
} from '../../ordering';
import { UNKNOWN_CATEGORY, type CategoryGoods } from '../domain/facts';
import type {
  RefundSource,
  ReportSources,
  SellerOrderSource,
  SellerOrderSourceRef,
  SourcePage,
  SourceUnavailable,
  SourceWindow,
} from '../application/ports/report-sources';

interface SourceLine {
  readonly offerId: Id<'Offer'>;
  readonly quantity: number;
  readonly goods: ReportAmount;
}

const unavailable = (cause: string): SourceUnavailable => ({
  code: 'reporting.source-unavailable',
  cause,
});

/**
 * {@link ReportSources} on the owners' public facades: ordering's reporting facade for the facts
 * and the changes, catalog's `offerPrimaryCategories` for the category of each line. The caller's
 * system-actor context goes unchanged to every facade. An Offer catalog cannot place (unknown, or
 * its product has no published revision) goes to `UNKNOWN_CATEGORY`; for a refund, the goods its
 * lines do not cover (a line whose Offer is gone) go there too, so the goods by category always
 * add up to the fact's goods.
 */
export class FacadeReportSources implements ReportSources {
  constructor(
    private readonly ordering: OrderingReportingFacade,
    private readonly catalog: CatalogFacade,
  ) {}

  async sellerOrders(
    context: CallContext,
    refs: readonly SellerOrderSourceRef[],
  ): Promise<Result<readonly SellerOrderSource[], SourceUnavailable>> {
    const facts = await this.ordering.sellerOrderReportFacts(context, {
      sellerOrders: refs.map((ref) => ({
        orderId: ref.orderId as Id<'Order'>,
        sellerOrderId: ref.sellerOrderId as Id<'SellerOrder'> | null,
      })),
    });
    if (!facts.ok) return err(unavailable(`ordering ${facts.error.code}`));
    const categories = await this.categoriesOf(
      context,
      facts.value.flatMap((fact) => fact.lines),
    );
    if (!categories.ok) return categories;
    return ok(facts.value.map((fact) => sellerOrderSource(fact, categories.value)));
  }

  async refunds(
    context: CallContext,
    refundIds: readonly string[],
  ): Promise<Result<readonly RefundSource[], SourceUnavailable>> {
    const facts = await this.ordering.refundReportFacts(context, {
      refundIds: refundIds as readonly Id<'Refund'>[],
    });
    if (!facts.ok) return err(unavailable(`ordering ${facts.error.code}`));
    const categories = await this.categoriesOf(
      context,
      facts.value.flatMap((fact) => fact.lines),
    );
    if (!categories.ok) return categories;
    return ok(facts.value.map((fact) => refundSource(fact, categories.value)));
  }

  async changedSellerOrders(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<SellerOrderSourceRef>, SourceUnavailable>> {
    const page = await this.ordering.sellerOrdersChanged(context, { window, after, limit });
    if (!page.ok) return err(unavailable(`ordering ${page.error.code}`));
    return ok({
      items: page.value.items.map((ref) => ({
        orderId: ref.orderId,
        sellerOrderId: ref.sellerOrderId,
      })),
      next: page.value.next,
    });
  }

  async succeededRefunds(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<string>, SourceUnavailable>> {
    const page = await this.ordering.refundsSucceeded(context, { window, after, limit });
    if (!page.ok) return err(unavailable(`ordering ${page.error.code}`));
    return ok({ items: page.value.items, next: page.value.next });
  }

  /** The primary category of every Offer of the lines, in one catalog call (at most 200 Offers). */
  private async categoriesOf(
    context: CallContext,
    lines: readonly SourceLine[],
  ): Promise<Result<ReadonlyMap<Id<'Offer'>, Id<'Category'>>, SourceUnavailable>> {
    const offerIds = [...new Set(lines.map((line) => line.offerId))];
    const found = new Map<Id<'Offer'>, Id<'Category'>>();
    for (let start = 0; start < offerIds.length; start += CATALOG_BATCH) {
      const answer = await this.catalog.offerPrimaryCategories(
        context,
        offerIds.slice(start, start + CATALOG_BATCH),
      );
      if (!answer.ok) return err(unavailable(`catalog ${answer.error.code}`));
      for (const [offerId, categoryId] of answer.value) found.set(offerId, categoryId);
    }
    return ok(found);
  }
}

/** Catalog's `MAX_FACADE_BATCH`. */
const CATALOG_BATCH = 200;

function goodsOf(
  lines: readonly SourceLine[],
  categories: ReadonlyMap<Id<'Offer'>, Id<'Category'>>,
): CategoryGoods[] {
  return lines.map((line) => ({
    categoryId: categories.get(line.offerId) ?? UNKNOWN_CATEGORY,
    goods: { amount: line.goods.amount, tax: line.goods.tax },
    units: line.quantity,
  }));
}

const sum = (lines: readonly SourceLine[]): ReportAmount =>
  lines.reduce(
    (total, line) => ({
      amount: total.amount + line.goods.amount,
      tax: total.tax + line.goods.tax,
    }),
    { amount: 0n, tax: 0n },
  );

export function sellerOrderSource(
  fact: SellerOrderReportFacts,
  categories: ReadonlyMap<Id<'Offer'>, Id<'Category'>>,
): SellerOrderSource {
  return {
    order: {
      sellerOrderId: fact.sellerOrderId,
      orderId: fact.orderId,
      sellerId: fact.sellerId,
      currency: fact.currency,
      goods: sum(fact.lines),
      units: fact.lines.reduce((units, line) => units + line.quantity, 0),
      shipping: fact.shipping,
      paidAt: fact.paidAt,
      cancelledAt: fact.cancelledAt,
      shippedAt: fact.shippedAt,
      shippedOnTime: fact.shippedOnTime,
      deliveredAt: fact.deliveredAt,
    },
    goods: goodsOf(fact.lines, categories),
  };
}

export function refundSource(
  fact: RefundReportFacts,
  categories: ReadonlyMap<Id<'Offer'>, Id<'Category'>>,
): RefundSource {
  const goods = goodsOf(fact.lines, categories);
  const lines = sum(fact.lines);
  const rest = {
    amount: fact.total.amount - fact.shipping.amount - lines.amount,
    tax: fact.total.tax - fact.shipping.tax - lines.tax,
  };
  // What the lines do not cover stays in the total, in no known category. Lines that cover more
  // than the goods are left as they are: the recorder refuses them (goods must add up).
  if (rest.amount >= 0n && rest.tax >= 0n && (rest.amount > 0n || rest.tax > 0n)) {
    goods.push({ categoryId: UNKNOWN_CATEGORY, goods: rest, units: 0 });
  }
  return {
    refund: {
      refundId: fact.refundId,
      orderId: fact.orderId,
      sellerOrderId: fact.sellerOrderId,
      sellerId: fact.sellerId,
      currency: fact.currency,
      total: fact.total,
      shipping: fact.shipping,
      refundedAt: fact.refundedAt,
    },
    goods,
  };
}
