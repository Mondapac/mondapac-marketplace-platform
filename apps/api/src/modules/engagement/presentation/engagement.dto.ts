import { ApiProperty } from '@nestjs/swagger';
import { BLOCK_EVENT_TYPES, MAX_BLOCK_EVENTS, MAX_STATS_DAYS } from '../domain/block-count';
import { BEHAVIOUR_KINDS, MAX_SEARCH_QUERY_LENGTH } from '../domain/behaviour-event';
import type { BlockStatsView } from '../application/use-cases/view-block-stats.use-case';
import type { PersonalizationView } from '../application/use-cases/view-personalization.use-case';
import type { MyStoresPage } from '../application/use-cases/list-my-stores.use-case';
import type { FollowState } from '../application/use-cases/view-store-follow.use-case';

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

export class StoreFollowBody {
  @ApiProperty({ format: 'uuid' })
  sellerId!: string;
  @ApiProperty()
  following!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  followedAt!: string | null;
}

export const storeFollowBody = (state: FollowState): StoreFollowBody => ({
  sellerId: state.sellerId,
  following: state.following,
  followedAt: state.followedAt?.toString() ?? null,
});

export class MyStoreLogoBody {
  @ApiProperty({ description: 'Names the image in the public image route.' })
  id!: string;
  @ApiProperty({ description: 'Pixels of the `large` size.' }) width!: number;
  @ApiProperty({ description: 'Pixels of the `large` size.' }) height!: number;
}

export class MyStoreBody {
  @ApiProperty({ format: 'uuid' })
  sellerId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The store address now; null when the store is no longer public.',
  })
  slug!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The public store name now; null when the store is no longer public.',
  })
  name!: string | null;
  @ApiProperty({
    type: MyStoreLogoBody,
    nullable: true,
    description:
      'The current logo, or null when there is none or the store is no longer public. Read it at ' +
      '`GET sellers/stores/:slug/images/:id/:size` (size small or large).',
  })
  logo!: MyStoreLogoBody | null;
  @ApiProperty({ format: 'date-time' })
  followedAt!: string;
}

export class MyStoresBody {
  @ApiProperty({ type: [MyStoreBody] })
  items!: MyStoreBody[];
  @ApiProperty({ description: 'Every store the customer follows.' })
  total!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Pass as `cursor` for the next page.' })
  nextCursor!: string | null;
}

export const myStoresBody = (page: MyStoresPage): MyStoresBody => ({
  items: page.items.map((item) => ({
    sellerId: item.sellerId,
    slug: item.slug,
    name: item.name,
    logo:
      item.logo === null
        ? null
        : { id: item.logo.id, width: item.logo.width, height: item.logo.height },
    followedAt: item.followedAt.toString(),
  })),
  total: page.total,
  nextCursor: page.nextCursor,
});
