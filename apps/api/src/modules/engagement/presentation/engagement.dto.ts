import { ApiProperty } from '@nestjs/swagger';
import { BLOCK_EVENT_TYPES, MAX_BLOCK_EVENTS, MAX_STATS_DAYS } from '../domain/block-count';
import { BEHAVIOUR_KINDS, MAX_SEARCH_QUERY_LENGTH } from '../domain/behaviour-event';
import type { BlockStatsView } from '../application/use-cases/view-block-stats.use-case';
import type { PersonalizationView } from '../application/use-cases/view-personalization.use-case';

// Bodies of the engagement routes.

export class BehaviourEventRequest {
  @ApiProperty({
    enum: BEHAVIOUR_KINDS,
    description:
      'product-viewed (productId, offerId?), category-viewed (categoryId), ' +
      'search-performed (query) or added-to-cart (offerId, variantId). A field of another kind is refused.',
  })
  kind!: string;
  @ApiProperty({ required: false, format: 'uuid' })
  productId?: string;
  @ApiProperty({ required: false, format: 'uuid' })
  offerId?: string;
  @ApiProperty({ required: false, format: 'uuid' })
  variantId?: string;
  @ApiProperty({ required: false, format: 'uuid' })
  categoryId?: string;
  @ApiProperty({
    required: false,
    maxLength: MAX_SEARCH_QUERY_LENGTH,
    description: 'The search text as typed; kept normalized, never logged.',
  })
  query?: string;
}

export class BlockEventRequest {
  @ApiProperty({ format: 'uuid', description: 'The published page the block is on.' })
  pageId!: string;
  @ApiProperty({ format: 'uuid', description: 'The id of the module placement (the block).' })
  placementId!: string;
  @ApiProperty({ enum: BLOCK_EVENT_TYPES })
  type!: string;
}

export class BlockEventsRequest {
  @ApiProperty({
    type: [BlockEventRequest],
    minItems: 1,
    maxItems: MAX_BLOCK_EVENTS,
    description: 'Identical events of one request count once.',
  })
  events!: BlockEventRequest[];
}

export class RecordedBody {
  @ApiProperty({
    description:
      'false when nothing was kept: the browser sent Sec-GPC: 1 or the customer switched personalization off.',
  })
  recorded!: boolean;
}

export class PersonalizationRequest {
  @ApiProperty({
    description: 'true: use my shopping behaviour to personalize; false: stop and delete it.',
  })
  enabled!: boolean;
}

export class PersonalizationBody {
  @ApiProperty({ description: 'Whether shopping behaviour is recorded and used.' })
  enabled!: boolean;
  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'When the customer last changed it; null when they never did.',
  })
  changedAt!: string | null;
}

export const personalizationBody = (view: PersonalizationView): PersonalizationBody => ({
  enabled: view.enabled,
  changedAt: view.changedAt?.toString() ?? null,
});

export class BlockDayBody {
  @ApiProperty({ format: 'date', description: 'A UTC calendar day.' })
  day!: string;
  @ApiProperty()
  impressions!: number;
  @ApiProperty()
  clicks!: number;
}

export class BlockStatsBody {
  @ApiProperty({ description: 'The id of the module placement (the block).' })
  placementId!: string;
  @ApiProperty({ description: 'Times shown over the span.' })
  impressions!: number;
  @ApiProperty({ description: 'Times clicked over the span.' })
  clicks!: number;
  @ApiProperty({ type: [BlockDayBody], description: 'Only the days that have a count, in order.' })
  days!: BlockDayBody[];
}

export class PageBlockStatsBody {
  @ApiProperty({ format: 'uuid' })
  pageId!: string;
  @ApiProperty({ format: 'date' })
  from!: string;
  @ApiProperty({ format: 'date', description: `At most ${MAX_STATS_DAYS} days after from.` })
  to!: string;
  @ApiProperty({ description: 'true: the span holds more rows than one read loads.' })
  truncated!: boolean;
  @ApiProperty({
    type: [BlockStatsBody],
    description:
      'Blocks with a count, most shown first. A placement no longer on the page may appear.',
  })
  blocks!: BlockStatsBody[];
}

export const pageBlockStatsBody = (view: BlockStatsView): PageBlockStatsBody => ({
  pageId: view.pageId,
  from: view.from.toString(),
  to: view.to.toString(),
  truncated: view.truncated,
  blocks: view.blocks.map((block) => ({
    placementId: block.placementId,
    impressions: block.impressions,
    clicks: block.clicks,
    days: block.days.map((d) => ({
      day: d.day.toString(),
      impressions: d.impressions,
      clicks: d.clicks,
    })),
  })),
});
