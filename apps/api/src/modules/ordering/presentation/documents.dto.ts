import { ApiProperty } from '@nestjs/swagger';
import type { Money } from '@mondapac/shared-kernel';
import type { OrderDocumentView } from '../application/use-cases/view-order-document.use-case';
import { moneyBody } from './http-answers';
import { MoneyView } from './orders.dto';

// The order document's answer (tax step 4): ids, codes, minor-unit strings and instants only.

export class OrderDocumentLineBody {
  @ApiProperty({ format: 'uuid' }) lineId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: MoneyView }) unitPrice!: MoneyView;
  @ApiProperty({ type: MoneyView }) lineAmount!: MoneyView;
  @ApiProperty() taxInclusive!: boolean;
  @ApiProperty({ nullable: true, type: Number }) taxRateBps!: number | null;
  @ApiProperty({ type: MoneyView, nullable: true, description: 'Null when not recorded.' })
  tax!: MoneyView | null;
}

export class OrderDocumentPartBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ type: [OrderDocumentLineBody] }) lines!: OrderDocumentLineBody[];
  @ApiProperty({ type: MoneyView }) subtotal!: MoneyView;
  @ApiProperty({ type: MoneyView }) shipping!: MoneyView;
  @ApiProperty({ type: MoneyView, nullable: true }) shippingTax!: MoneyView | null;
  @ApiProperty({ type: MoneyView, nullable: true }) tax!: MoneyView | null;
  @ApiProperty({ type: MoneyView }) total!: MoneyView;
}

export class OrderDocumentBody {
  @ApiProperty({
    enum: ['order-confirmation'],
    description: 'An order confirmation while tax.invoice.enabled is off; never a tax invoice yet.',
  })
  kind!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Always null for now (AG-11).' })
  documentNumber!: null;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) sellerOrderId!: string | null;
  @ApiProperty({ format: 'date-time' }) paidAt!: string;
  @ApiProperty({ type: [OrderDocumentPartBody] }) parts!: OrderDocumentPartBody[];
  @ApiProperty({ type: MoneyView }) total!: MoneyView;
  @ApiProperty({ type: MoneyView, nullable: true }) tax!: MoneyView | null;
}

const orNull = (value: Money | null) => (value === null ? null : moneyBody(value));

export const orderDocumentBody = (document: OrderDocumentView): OrderDocumentBody => ({
  kind: document.kind,
  documentNumber: document.documentNumber,
  orderId: document.orderId,
  sellerOrderId: document.sellerOrderId,
  paidAt: document.paidAt.toString(),
  parts: document.parts.map((part) => ({
    sellerId: part.sellerId,
    lines: part.lines.map((line) => ({
      lineId: line.lineId,
      offerId: line.offerId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: moneyBody(line.unitPrice),
      lineAmount: moneyBody(line.lineAmount),
      taxInclusive: line.taxInclusive,
      taxRateBps: line.taxRateBps,
      tax: orNull(line.tax),
    })),
    subtotal: moneyBody(part.subtotal),
    shipping: moneyBody(part.shipping),
    shippingTax: orNull(part.shippingTax),
    tax: orNull(part.tax),
    total: moneyBody(part.total),
  })),
  total: moneyBody(document.total),
  tax: orNull(document.tax),
});
