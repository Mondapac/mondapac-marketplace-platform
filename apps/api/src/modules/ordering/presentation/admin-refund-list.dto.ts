import { ApiProperty } from '@nestjs/swagger';
import { REFUND_ROW_ACTIONS, type RefundListPage } from '../domain/admin-refund-list';
import { LOSS_BEARERS, LOSS_REASON_CODES } from '../domain/reason-codes';
import { REFUND_REASONS } from '../domain/refund';
import { moneyBody } from './http-answers';
import { MoneyView, OrderCustomerBody } from './orders.dto';

// The answer of GET /ordering/admin/refunds: ids, codes, minor-unit strings and instants, plus the
// store name and (for an admin who may see customers) the customer's name and email.

export class RefundListRowBody {
  @ApiProperty({ format: 'uuid' }) refundId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The store's public name; seller text, escape it.",
  })
  storeName!: string | null;
  @ApiProperty({ format: 'uuid', description: "The order's customer account." })
  accountId!: string;
  @ApiProperty({
    type: OrderCustomerBody,
    nullable: true,
    description:
      'Null without identity.customer-account.view or when the lookup failed. Personal data.',
  })
  customer!: OrderCustomerBody | null;
  @ApiProperty({ type: MoneyView, description: 'What goes back to the customer, tax included.' })
  gross!: MoneyView;
  @ApiProperty({ type: MoneyView, description: 'The tax inside `gross`.' }) tax!: MoneyView;
  @ApiProperty({ type: MoneyView, description: 'The shipping part of `gross`; zero when none.' })
  shippingGross!: MoneyView;
  @ApiProperty({ enum: REFUND_REASONS }) reason!: string;
  @ApiProperty({ enum: ['admin', 'seller'], description: 'Who asked for the refund.' })
  actor!: string;
  @ApiProperty({ enum: ['pending', 'succeeded', 'failed'] }) state!: string;
  @ApiProperty({ enum: LOSS_BEARERS }) lossBearer!: string;
  @ApiProperty({ type: String, nullable: true, enum: LOSS_REASON_CODES })
  lossReasonCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Stripe's refund id, once made." })
  stripeRefundId!: string | null;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) settledAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'When the refund went into the seller ledger; null until then.',
  })
  ledgerRecordedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Succeeded only.' })
  creditNoteId!: string | null;
  @ApiProperty({
    enum: REFUND_ROW_ACTIONS,
    isArray: true,
    description: "The row's Actions menu, as the server allows it for this caller and row.",
  })
  actions!: string[];
}

export class RefundStateCountsBody {
  @ApiProperty() pending!: number;
  @ApiProperty() succeeded!: number;
  @ApiProperty() failed!: number;
}

export class RefundListPageBody {
  @ApiProperty({ type: [RefundListRowBody] }) refunds!: RefundListRowBody[];
  @ApiProperty({
    type: RefundStateCountsBody,
    description: "The Market's refunds per state, whatever the page or filter (the tab counts).",
  })
  counts!: RefundStateCountsBody;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The refunds that match the filter; null on a Previous/Next page.',
  })
  total!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'This page, from 1; null on a Previous/Next page.',
  })
  page!: number | null;
  @ApiProperty({ description: 'Rows per page (the `limit` on a Previous/Next page).' })
  pageSize!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Previous/Next paging: the `cursor` of the next page; null on the last one.',
  })
  nextCursor!: string | null;
  @ApiProperty({
    description:
      'True when `search` matched more than 200 customers or stores, so some are left out.',
  })
  searchCapped!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['customers-and-stores', 'stores'],
    description: 'What `search` looked in; null without `search`.',
  })
  searchScope!: 'customers-and-stores' | 'stores' | null;
}

const instant = (value: { toString(): string } | null) =>
  value === null ? null : value.toString();

export function refundListPageBody(page: RefundListPage): RefundListPageBody {
  return {
    refunds: page.rows.map((row) => ({
      refundId: row.refundId,
      orderId: row.orderId,
      sellerOrderId: row.sellerOrderId,
      sellerId: row.sellerId,
      storeName: row.storeName,
      accountId: row.accountId,
      customer:
        row.customer === null
          ? null
          : { displayName: row.customer.displayName, email: row.customer.email },
      gross: moneyBody(row.gross),
      tax: moneyBody(row.tax),
      shippingGross: moneyBody(row.shippingGross),
      reason: row.reason,
      actor: row.actor,
      state: row.state,
      lossBearer: row.lossBearer,
      lossReasonCode: row.lossReasonCode,
      stripeRefundId: row.stripeRefundId,
      requestedAt: row.requestedAt.toString(),
      settledAt: instant(row.settledAt),
      ledgerRecordedAt: instant(row.ledgerRecordedAt),
      creditNoteId: row.creditNoteId,
      actions: [...row.actions],
    })),
    counts: { ...page.counts },
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    nextCursor: page.nextCursor,
    searchCapped: page.searchCapped,
    searchScope: page.searchScope,
  };
}
