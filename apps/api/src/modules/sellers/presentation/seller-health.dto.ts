import { ApiProperty } from '@nestjs/swagger';

export class SellerHealthMetricBody {
  @ApiProperty({
    enum: ['seller-cancellations', 'late-ready', 'customer-rating', 'lost-disputes', 'reports'],
  })
  metric!: string;

  @ApiProperty({ enum: ['scored', 'no-data'] })
  kind!: 'scored' | 'no-data';

  @ApiProperty({ enum: ['healthy', 'at-risk', 'unhealthy'], nullable: true, required: false })
  band?: 'healthy' | 'at-risk' | 'unhealthy';

  @ApiProperty({ minimum: 0, maximum: 100, required: false })
  score?: number;
}

export class SellerHealthCardBody {
  @ApiProperty({ example: '2026-11-03', description: "The seller's local date of the snapshot." })
  day!: string;

  @ApiProperty({ enum: ['scored', 'new', 'no-data'] })
  kind!: 'scored' | 'new' | 'no-data';

  @ApiProperty({ enum: ['healthy', 'at-risk', 'unhealthy'], nullable: true })
  band!: 'healthy' | 'at-risk' | 'unhealthy' | null;

  @ApiProperty({ nullable: true, minimum: 0, maximum: 100 })
  score!: number | null;

  @ApiProperty({ nullable: true, description: 'The metric that set the overall score.' })
  lowestMetric!: string | null;

  @ApiProperty({ example: 'v1' })
  formulaVersion!: string;

  @ApiProperty({ description: 'ISO instant of the night that computed it.' })
  computedAt!: string;

  @ApiProperty({ description: 'Orders in the long window (the New label compares it).' })
  orders!: number;

  @ApiProperty({ type: [SellerHealthMetricBody] })
  metrics!: SellerHealthMetricBody[];
}

export class SellerHealthTrendPointBody {
  @ApiProperty({ example: '2026-11-03' })
  day!: string;

  @ApiProperty({ enum: ['scored', 'new', 'no-data'] })
  kind!: 'scored' | 'new' | 'no-data';

  @ApiProperty({ nullable: true })
  score!: number | null;
}

export class SellerHealthBody {
  @ApiProperty()
  sellerId!: string;

  @ApiProperty({
    type: SellerHealthCardBody,
    nullable: true,
    description: 'The latest snapshot, or null when no night has measured the seller yet.',
  })
  current!: SellerHealthCardBody | null;

  @ApiProperty({ type: [SellerHealthTrendPointBody], description: 'Oldest first, last 90 days.' })
  trend!: SellerHealthTrendPointBody[];
}
