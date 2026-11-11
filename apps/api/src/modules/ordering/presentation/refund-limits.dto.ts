import { ApiProperty } from '@nestjs/swagger';
import type { RefundLimitsView, RefundLimitView } from '../application/refund-limits-flow';
import { MAX_REFUND_LIMIT_COUNT } from '../domain/refund-limits';
import { moneyBody } from './http-answers';
import { MoneyView } from './orders.dto';

// Bodies and answers of the admin routes for the caps on seller refunds (order detail decision 6;
// Hassan F2). Counts, minor-unit strings, versions and instants only.

export const REFUND_LIMIT_BODY_KEYS = ['maxCount', 'maxAmount', 'expectedVersion'] as const;

export class RefundLimitRequestBody {
  @ApiProperty({
    minimum: 1,
    maximum: MAX_REFUND_LIMIT_COUNT,
    description: 'The most seller refunds in any 24 hours.',
  })
  maxCount!: number;
  @ApiProperty({
    description:
      'The most a seller may refund in any 24 hours, minor units of the Market currency.',
    example: '50000',
  })
  maxAmount!: string;
  @ApiProperty({ description: 'The version read; 0 when the cap is not set yet.' })
  expectedVersion!: number;
}

export class RefundLimitBody {
  @ApiProperty() maxCount!: number;
  @ApiProperty({ type: MoneyView }) maxAmount!: MoneyView;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ format: 'uuid' }) updatedBy!: string;
}

export class RefundLimitsBody {
  @ApiProperty({ description: 'The Market currency the caps are set in.' }) currency!: string;
  @ApiProperty({ type: RefundLimitBody, nullable: true }) marketDefault!: RefundLimitBody | null;
  @ApiProperty({ format: 'uuid', nullable: true }) sellerId!: string | null;
  @ApiProperty({
    type: RefundLimitBody,
    nullable: true,
    description: "The seller's own cap; null when none or no seller was named.",
  })
  own!: RefundLimitBody | null;
  @ApiProperty({
    enum: ['own', 'market', 'none'],
    description: 'Which cap applies to the seller; none refuses every seller refund.',
  })
  inForce!: string;
}

const limitBody = (limit: RefundLimitView | null) =>
  limit === null
    ? null
    : {
        maxCount: limit.maxCount,
        maxAmount: moneyBody(limit.maxAmount),
        version: limit.version,
        updatedAt: limit.updatedAt,
        updatedBy: limit.updatedBy,
      };

export const refundLimitsBody = (view: RefundLimitsView) => ({
  currency: view.currency,
  marketDefault: limitBody(view.marketDefault),
  sellerId: view.sellerId,
  own: limitBody(view.own),
  inForce: view.inForce,
});
