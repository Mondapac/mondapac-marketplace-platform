import { ApiProperty } from '@nestjs/swagger';
import {
  DOCUMENT_KINDS,
  DOCUMENT_ROW_ACTIONS,
  type DocumentListPage,
} from '../domain/admin-document-list';
import { REFUND_REASONS } from '../domain/refund';
import { moneyBody } from './http-answers';
import { MoneyView, OrderCustomerBody } from './orders.dto';

// The answer of GET /ordering/admin/documents (Sales > Invoices): order confirmations and credit
// notes. Neither is a tax invoice yet: `documentNumber` is always null (AG-11).

export class DocumentListRowBody {
  @ApiProperty({ enum: DOCUMENT_KINDS }) kind!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'The seller order id of a confirmation; the credit note id of a credit note.',
  })
  documentId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Always null until numbered tax invoices exist.',
  })
  documentNumber!: null;
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
  @ApiProperty({
    format: 'date-time',
    description: 'When the payment was confirmed, or when the refund succeeded.',
  })
  issuedAt!: string;
  @ApiProperty({ type: MoneyView, description: 'Tax included.' }) total!: MoneyView;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: 'The tax inside `total`; null when a line was placed before tax was recorded.',
  })
  tax!: MoneyView | null;
  @ApiProperty({
    type: MoneyView,
    description: 'The delivery fee as paid, or the shipping refunded; both tax included.',
  })
  shipping!: MoneyView;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Credit notes only.' })
  refundId!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: REFUND_REASONS })
  refundReason!: string | null;
  @ApiProperty({
    enum: DOCUMENT_ROW_ACTIONS,
    isArray: true,
    description: "The row's Actions menu, as the server allows it for this caller and row.",
  })
  actions!: string[];
}

export class DocumentKindCountsBody {
  @ApiProperty() orderConfirmations!: number;
  @ApiProperty() creditNotes!: number;
}

export class DocumentListPageBody {
  @ApiProperty({ type: [DocumentListRowBody] }) documents!: DocumentListRowBody[];
  @ApiProperty({
    type: DocumentKindCountsBody,
    description: "The Market's documents per kind, whatever the page or filter (the tab counts).",
  })
  counts!: DocumentKindCountsBody;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The documents of the kind that match the filter; null on a Previous/Next page.',
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

export function documentListPageBody(page: DocumentListPage): DocumentListPageBody {
  return {
    documents: page.rows.map((row) => ({
      kind: row.kind,
      documentId: row.documentId,
      documentNumber: null,
      orderId: row.orderId,
      sellerOrderId: row.sellerOrderId,
      sellerId: row.sellerId,
      storeName: row.storeName,
      accountId: row.accountId,
      customer:
        row.customer === null
          ? null
          : { displayName: row.customer.displayName, email: row.customer.email },
      issuedAt: row.issuedAt.toString(),
      total: moneyBody(row.total),
      tax: row.tax === null ? null : moneyBody(row.tax),
      shipping: moneyBody(row.shipping),
      refundId: row.refundId,
      refundReason: row.refundReason,
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
