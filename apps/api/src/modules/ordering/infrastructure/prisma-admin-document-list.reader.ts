import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminDocumentListReader } from '../application/ports/admin-document-list.reader';
import type {
  DocumentCursor,
  DocumentKindCounts,
  DocumentListFilter,
  DocumentListRecord,
  DocumentSort,
} from '../domain/admin-document-list';
import { linesTax, shippingTaxOf } from '../domain/order';
import type { RefundReason } from '../domain/refund';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const range = (from: Temporal.Instant | null, to: Temporal.Instant | null) => ({
  ...(from === null ? {} : { gte: toDate(from) }),
  ...(to === null ? {} : { lt: toDate(to) }),
});
const amounts = (min: bigint | null, max: bigint | null) => ({
  ...(min === null ? {} : { gte: min }),
  ...(max === null ? {} : { lte: max }),
});

const CONFIRMATION_SELECT = {
  id: true,
  orderId: true,
  sellerId: true,
  totalAmount: true,
  paidAt: true,
  shippingAmount: true,
  shippingTaxAmount: true,
  shippingTaxInclusive: true,
  order: { select: { accountId: true, currency: true } },
  lines: { select: { taxAmount: true } },
} as const;

const CREDIT_NOTE_SELECT = {
  id: true,
  refundId: true,
  orderId: true,
  sellerOrderId: true,
  sellerId: true,
  currency: true,
  grossAmount: true,
  taxAmount: true,
  issuedAt: true,
  refund: {
    select: {
      reason: true,
      shippingGrossAmount: true,
      sellerOrder: { select: { order: { select: { accountId: true } } } },
    },
  },
} as const;

/**
 * Paid seller orders of the Market: their order confirmations. `paid_at` is set exactly when the
 * order is confirmed, so this reads `ordering.seller_orders` alone over its paid-at partial index;
 * only a customer search joins the order (for its account).
 */
function confirmationWhere(market: MarketContext, filter: DocumentListFilter) {
  const and: object[] = [];
  if (filter.ids !== null) and.push({ id: { in: [...filter.ids] } });
  if (filter.reference !== null) {
    and.push({ OR: [{ id: filter.reference }, { orderId: filter.reference }] });
  }
  if (filter.parties !== null) {
    and.push({
      OR: [
        { sellerId: { in: [...filter.parties.sellerIds] } },
        {
          order: {
            marketId: market.marketId,
            accountId: { in: [...filter.parties.accountIds] },
          },
        },
      ],
    });
  }
  return {
    marketId: market.marketId,
    paidAt: { not: null, ...range(filter.from, filter.to) },
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : { totalAmount: amounts(filter.minAmount, filter.maxAmount) }),
    AND: and,
  };
}

/** The Market's credit notes (one per succeeded refund). */
function creditNoteWhere(market: MarketContext, filter: DocumentListFilter) {
  const and: object[] = [];
  if (filter.ids !== null) and.push({ id: { in: [...filter.ids] } });
  if (filter.reference !== null) {
    and.push({
      OR: [
        { id: filter.reference },
        { refundId: filter.reference },
        { orderId: filter.reference },
        { sellerOrderId: filter.reference },
      ],
    });
  }
  if (filter.parties !== null) {
    and.push({
      OR: [
        { sellerId: { in: [...filter.parties.sellerIds] } },
        {
          refund: {
            sellerOrder: {
              order: {
                marketId: market.marketId,
                accountId: { in: [...filter.parties.accountIds] },
              },
            },
          },
        },
      ],
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.from === null && filter.to === null
      ? {}
      : { issuedAt: range(filter.from, filter.to) }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : { grossAmount: amounts(filter.minAmount, filter.maxAmount) }),
    AND: and,
  };
}

/**
 * The tax of a paid seller order, by the same domain rules as the order page: its lines' frozen
 * tax (null when a line was placed before tax was recorded) plus its delivery fee's.
 */
function confirmationTax(row: {
  readonly shippingTaxAmount: bigint | null;
  readonly lines: readonly { readonly taxAmount: bigint | null }[];
}): bigint | null {
  const lines = linesTax(row.lines);
  return lines === null ? null : lines + shippingTaxOf({ shippingTax: row.shippingTaxAmount });
}

/** What the buyer paid for delivery, tax included: the fee, plus its tax where it was excluded. */
function shippingGross(row: {
  readonly shippingAmount: bigint;
  readonly shippingTaxAmount: bigint | null;
  readonly shippingTaxInclusive: boolean | null;
}): bigint {
  return row.shippingTaxInclusive === false && row.shippingTaxAmount !== null
    ? row.shippingAmount + row.shippingTaxAmount
    : row.shippingAmount;
}

/**
 * Keyset: after `after`, newest first (issued time, then id). The plain bound lets the index
 * start at the cursor; the OR keeps the tie order.
 */
const afterWhere = (field: 'paidAt' | 'issuedAt', after: DocumentCursor) => ({
  [field]: { lte: toDate(after.issuedAt) },
  OR: [
    { [field]: { lt: toDate(after.issuedAt) } },
    { [field]: toDate(after.issuedAt), id: { lt: after.documentId } },
  ],
});

/** The admin Invoices list: order confirmations and credit notes, one kind per read. */
export class PrismaAdminDocumentListReader implements AdminDocumentListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: DocumentListFilter,
    sort: DocumentSort,
    offset: number,
    limit: number,
    after: DocumentCursor | null = null,
  ): Promise<readonly DocumentListRecord[]> {
    const tx = this.prisma.tx(market);
    const tie = { id: sort.direction };
    if (filter.kind === 'credit-note') {
      const rows = await tx.orderingCreditNote.findMany({
        where: (() => {
          const base = creditNoteWhere(market, filter);
          return after === null
            ? base
            : { ...base, AND: [...base.AND, afterWhere('issuedAt', after)] };
        })(),
        select: CREDIT_NOTE_SELECT,
        orderBy:
          sort.key === 'amount'
            ? [{ grossAmount: sort.direction }, tie]
            : [{ issuedAt: sort.direction }, tie],
        skip: offset,
        take: limit,
      });
      return rows.map((row) => ({
        kind: 'credit-note' as const,
        documentId: row.id,
        orderId: row.orderId as Id<'Order'>,
        sellerOrderId: row.sellerOrderId as Id<'SellerOrder'>,
        sellerId: row.sellerId as Id<'Seller'>,
        accountId: row.refund.sellerOrder.order.accountId as Id<'Account'>,
        issuedAt: toInstant(row.issuedAt),
        total: { amount: row.grossAmount, currency: row.currency },
        tax: { amount: row.taxAmount, currency: row.currency },
        shipping: { amount: row.refund.shippingGrossAmount, currency: row.currency },
        refundId: row.refundId as Id<'Refund'>,
        refundReason: row.refund.reason as RefundReason,
      }));
    }
    const rows = await tx.orderingSellerOrder.findMany({
      where: (() => {
        const base = confirmationWhere(market, filter);
        return after === null ? base : { ...base, AND: [...base.AND, afterWhere('paidAt', after)] };
      })(),
      select: CONFIRMATION_SELECT,
      orderBy:
        sort.key === 'amount'
          ? [{ totalAmount: sort.direction }, tie]
          : [{ paidAt: sort.direction }, tie],
      skip: offset,
      take: limit,
    });
    return rows.map((row) => {
      const currency = row.order.currency;
      if (row.paidAt === null) {
        // The WHERE keeps paid seller orders only.
        throw new Error('ordering: a paid seller order without its payment time');
      }
      const tax = confirmationTax(row);
      return {
        kind: 'order-confirmation' as const,
        documentId: row.id,
        orderId: row.orderId as Id<'Order'>,
        sellerOrderId: row.id as Id<'SellerOrder'>,
        sellerId: row.sellerId as Id<'Seller'>,
        accountId: row.order.accountId as Id<'Account'>,
        issuedAt: toInstant(row.paidAt),
        total: { amount: row.totalAmount, currency },
        tax: tax === null ? null : { amount: tax, currency },
        shipping: { amount: shippingGross(row), currency },
        refundId: null,
        refundReason: null,
      };
    });
  }

  count(market: MarketContext, filter: DocumentListFilter): Promise<number> {
    const tx = this.prisma.tx(market);
    return filter.kind === 'credit-note'
      ? tx.orderingCreditNote.count({ where: creditNoteWhere(market, filter) })
      : tx.orderingSellerOrder.count({ where: confirmationWhere(market, filter) });
  }

  async countByKind(market: MarketContext): Promise<DocumentKindCounts> {
    const tx = this.prisma.tx(market);
    const [orderConfirmations, creditNotes] = await Promise.all([
      tx.orderingSellerOrder.count({
        where: { marketId: market.marketId, paidAt: { not: null } },
      }),
      tx.orderingCreditNote.count({ where: { marketId: market.marketId } }),
    ]);
    return { orderConfirmations, creditNotes };
  }
}
