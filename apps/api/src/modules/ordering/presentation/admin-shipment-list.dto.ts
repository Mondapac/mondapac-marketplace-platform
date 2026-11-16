import { ApiProperty } from '@nestjs/swagger';
import {
  SHIPMENT_ROW_ACTIONS,
  SHIPMENT_STAGES,
  type ShipmentListPage,
} from '../domain/admin-shipment-list';
import { DELIVERY_METHODS } from '../domain/delivery-method';
import { moneyBody } from './http-answers';
import { MoneyView, OrderCustomerBody } from './orders.dto';

// The answer of GET /ordering/admin/shipments: ids, codes, minor-unit strings and instants, plus
// the store name and (for an admin who may see customers) the customer's name and email. Never
// the delivery address.

export class ShipmentWindowBody {
  @ApiProperty({ format: 'date-time' }) start!: string;
  @ApiProperty({ format: 'date-time' }) end!: string;
}

export class ShipmentListRowBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
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
  @ApiProperty({ format: 'date-time', description: 'When the order was paid.' }) paidAt!: string;
  @ApiProperty({ enum: DELIVERY_METHODS }) deliveryMethod!: string;
  @ApiProperty({
    type: ShipmentWindowBody,
    nullable: true,
    description: 'The buyer window of a scheduled delivery.',
  })
  deliveryWindow!: ShipmentWindowBody | null;
  @ApiProperty({ enum: SHIPMENT_STAGES }) stage!: string;
  @ApiProperty({ enum: ['to-ship', 'shipped', 'delivered'] }) fulfilment!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) readyAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) shippedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) deliveredAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The carrier the seller named; seller text, escape it.',
  })
  carrier!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Seller text, escape it.' })
  trackingRef!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The fleet quoted at placement (shipping's code).",
  })
  fleet!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['no-carrier', 'carrier-unknown', 'cancel-unknown'],
    description: 'Set when the seller order needs an admin.',
  })
  deliveryAttention!: string | null;
  @ApiProperty({
    type: MoneyView,
    description:
      'What the buyer paid for delivery, tax included (fee plus its tax where excluded).',
  })
  shipping!: MoneyView;
  @ApiProperty({ type: MoneyView }) total!: MoneyView;
  @ApiProperty({ type: MoneyView, description: 'The gross of the refunds not failed.' })
  refunded!: MoneyView;
  @ApiProperty({
    enum: SHIPMENT_ROW_ACTIONS,
    isArray: true,
    description: "The row's Actions menu, as the server allows it for this caller and row.",
  })
  actions!: string[];
}

export class ShipmentStageCountsBody {
  @ApiProperty() toPrepare!: number;
  @ApiProperty() ready!: number;
  @ApiProperty() shipped!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty({ description: 'Refunded in full before shipping (an admin cancellation).' })
  refunded!: number;
  @ApiProperty({ description: 'Seller orders that need an admin, any stage.' }) attention!: number;
}

export class ShipmentListPageBody {
  @ApiProperty({ type: [ShipmentListRowBody] }) shipments!: ShipmentListRowBody[];
  @ApiProperty({
    type: ShipmentStageCountsBody,
    description: "The Market's shipments per stage, whatever the page or filter (the tab counts).",
  })
  counts!: ShipmentStageCountsBody;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The shipments that match the filter; null on a Previous/Next page.',
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

export function shipmentListPageBody(page: ShipmentListPage): ShipmentListPageBody {
  return {
    shipments: page.rows.map((row) => ({
      sellerOrderId: row.sellerOrderId,
      orderId: row.orderId,
      sellerId: row.sellerId,
      storeName: row.storeName,
      accountId: row.accountId,
      customer:
        row.customer === null
          ? null
          : { displayName: row.customer.displayName, email: row.customer.email },
      paidAt: row.paidAt.toString(),
      deliveryMethod: row.deliveryMethod,
      deliveryWindow:
        row.deliveryWindow === null
          ? null
          : { start: row.deliveryWindow.start.toString(), end: row.deliveryWindow.end.toString() },
      stage: row.stage,
      fulfilment: row.fulfilment,
      readyAt: instant(row.readyAt),
      shippedAt: instant(row.shippedAt),
      deliveredAt: instant(row.deliveredAt),
      carrier: row.carrier,
      trackingRef: row.trackingRef,
      fleet: row.fleet,
      deliveryAttention: row.deliveryAttention,
      shipping: moneyBody(row.shipping),
      total: moneyBody(row.total),
      refunded: moneyBody(row.refunded),
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
