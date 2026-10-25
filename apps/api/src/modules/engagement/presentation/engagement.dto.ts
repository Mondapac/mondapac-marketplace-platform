import { ApiProperty } from '@nestjs/swagger';
import { BLOCK_EVENT_TYPES, MAX_BLOCK_EVENTS } from '../domain/block-count';
import { BEHAVIOUR_KINDS, MAX_SEARCH_QUERY_LENGTH } from '../domain/behaviour-event';
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
