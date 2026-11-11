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

export class SellerHealthQueueItemBody {
  @ApiProperty({ description: 'The seller id (UUID v7).' })
  sellerId!: string;

  @ApiProperty({ type: String, nullable: true })
  storeName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The held slug, else the draft slug.' })
  slug!: string | null;

  @ApiProperty({ example: '2026-11-03', description: 'Local date of the latest snapshot.' })
  day!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  score!: number;

  @ApiProperty({ description: 'The metric that set the score: where to look first.' })
  lowestMetric!: string;
}

export class SellerHealthQueueBody {
  @ApiProperty({
    type: [SellerHealthQueueItemBody],
    description: 'Unhealthy sellers, worst score first.',
  })
  items!: SellerHealthQueueItemBody[];

  @ApiProperty({ description: 'True when more sellers were unhealthy than the queue holds.' })
  truncated!: boolean;
}

export class SellerHealthRecalculationBody {
  @ApiProperty({
    enum: ['queued', 'already-queued'],
    description:
      'queued: the request was written and the job measures the seller within about two minutes. ' +
      'already-queued: one was already waiting; nothing was added.',
  })
  status!: 'queued' | 'already-queued';
}

export class OwnSellerHealthRefreshBody {
  @ApiProperty({ description: 'A recount is waiting for the job.' })
  pending!: boolean;

  @ApiProperty({ minimum: 0, description: 'Seconds until "Refresh now" may be clicked; 0 = now.' })
  retryAfterSeconds!: number;
}

export class OwnSellerHealthBody {
  @ApiProperty({
    type: SellerHealthCardBody,
    nullable: true,
    description: 'The latest snapshot, or null when no night has measured the seller yet.',
  })
  current!: SellerHealthCardBody | null;

  @ApiProperty({ type: [SellerHealthTrendPointBody], description: 'Oldest first, last 90 days.' })
  trend!: SellerHealthTrendPointBody[];

  @ApiProperty({ type: OwnSellerHealthRefreshBody })
  refresh!: OwnSellerHealthRefreshBody;
}
