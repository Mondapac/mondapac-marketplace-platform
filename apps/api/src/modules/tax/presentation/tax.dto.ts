import { ApiProperty } from '@nestjs/swagger';
import type { StrategyView } from '../application/use-cases/create-tax-strategy.use-case';
import type { StrategyListView } from '../application/use-cases/list-tax-strategies.use-case';

// Bodies of the tax routes. Ids, basis points and category codes only.

export class StrategyBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['flat-rate', 'by-category'] }) kind!: string;
  @ApiProperty({ nullable: true, type: Number, description: 'flat-rate only, in basis points.' })
  rateBps!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'by-category only: the rate of a line in no listed category.',
  })
  defaultRateBps!: number | null;
  @ApiProperty({
    nullable: true,
    type: Object,
    additionalProperties: { type: 'number' },
    description: 'by-category only: category code to rate in basis points.',
  })
  categoryRatesBps!: Record<string, number> | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class StrategyListBody {
  @ApiProperty({
    description: 'The built-in strategy of the Market, in basis points (1000 = 10 %).',
  })
  builtInRateBps!: number;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  activeStrategyId!: string | null;
  @ApiProperty({
    type: [String],
    description: 'The tax categories a by-category strategy may name.',
  })
  categoryCodes!: string[];
  @ApiProperty({ type: [StrategyBody], description: 'Newest first.' })
  strategies!: StrategyBody[];
}

export class StrategyRequest {
  @ApiProperty({ example: 'GST 10 %' }) name!: string;
  @ApiProperty({ enum: ['flat-rate', 'by-category'] }) kind!: string;
  @ApiProperty({
    required: false,
    description: 'flat-rate: 0 to 5000 basis points.',
    example: 1000,
  })
  rateBps?: number;
  @ApiProperty({ required: false, description: 'by-category: 0 to 5000 basis points.' })
  defaultRateBps?: number;
  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: { type: 'number' },
    example: { taxable: 1000, gst_free: 0 },
  })
  categoryRatesBps?: Record<string, number>;
}

export class ActivateStrategyRequest {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The strategy to activate; null puts the Market back on the built-in strategy.',
  })
  strategyId!: string | null;
}

export const strategyBody = (view: StrategyView): StrategyBody => ({
  id: view.id,
  name: view.name,
  kind: view.params.kind,
  rateBps: view.params.kind === 'flat-rate' ? view.params.rateBps : null,
  defaultRateBps: view.params.kind === 'by-category' ? view.params.defaultRateBps : null,
  categoryRatesBps: view.params.kind === 'by-category' ? { ...view.params.categoryRatesBps } : null,
  active: view.active,
  createdAt: view.createdAt.toString(),
  updatedAt: view.updatedAt.toString(),
});

export const strategyListBody = (view: StrategyListView): StrategyListBody => ({
  builtInRateBps: view.builtInRateBps,
  activeStrategyId: view.activeStrategyId,
  categoryCodes: [...view.categoryCodes],
  strategies: view.strategies.map(strategyBody),
});
