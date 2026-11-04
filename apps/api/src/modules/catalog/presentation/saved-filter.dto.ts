import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ADMIN_PRODUCT_VIEWS,
  LISTED_STATUSES,
} from '../application/use-cases/admin-products-list.use-case';
import {
  ADMIN_PRODUCT_SORTS,
  SAVED_FILTER_LIST_KEYS,
} from '../application/use-cases/saved-filters-list.use-case';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  SAVED_FILTER_NAME_MAX,
  SAVED_FILTER_VISIBILITIES,
} from '../domain/saved-filter';
import { PRODUCT_SCOPES } from '../domain/product';

// The requests and answers of the saved filters of the admin lists (catalog design 9.2d).

export class SavedFilterConditionsDto {
  @ApiPropertyOptional({ enum: PRODUCT_SCOPES })
  scope?: string;

  @ApiPropertyOptional({ enum: LISTED_STATUSES })
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  categoryId?: string;

  @ApiPropertyOptional()
  typeCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  sellerId?: string;
}

export class SavedFilterPayloadDto {
  @ApiProperty({ enum: [1], description: 'The version of the document.' })
  v!: number;

  @ApiProperty({ enum: ADMIN_PRODUCT_VIEWS, description: 'The tab the filter opens on.' })
  view!: string;

  @ApiPropertyOptional({ description: 'The search text; up to 100 characters.' })
  q?: string;

  @ApiPropertyOptional({ type: SavedFilterConditionsDto })
  filters?: SavedFilterConditionsDto;

  @ApiProperty({ enum: ADMIN_PRODUCT_SORTS })
  sort!: string;

  @ApiProperty({ enum: ['asc', 'desc'] })
  direction!: string;
}

export class SavedFilterCreateRequest {
  @ApiProperty({ enum: SAVED_FILTER_LIST_KEYS, description: 'The list the filter belongs to.' })
  listKey!: string;

  @ApiProperty({
    maxLength: SAVED_FILTER_NAME_MAX,
    description: 'Trimmed, 1 to 60 characters, no control character; one per owner and list.',
  })
  name!: string;

  @ApiProperty({
    enum: SAVED_FILTER_VISIBILITIES,
    description: 'me, or everyone (needs catalog.saved-filter.share).',
  })
  visibility!: string;

  @ApiProperty({ type: SavedFilterPayloadDto })
  payload!: SavedFilterPayloadDto;
}

export class SavedFilterUpdateRequest {
  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX })
  name!: string;

  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES })
  visibility!: string;
}

export class SavedFilterDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SAVED_FILTER_LIST_KEYS })
  listKey!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES })
  visibility!: string;

  @ApiProperty({ type: SavedFilterPayloadDto })
  payload!: SavedFilterPayloadDto;

  @ApiProperty({ description: 'True for the caller’s own filter.' })
  ownedByMe!: boolean;

  @ApiProperty({
    description: 'Whether the caller may rename, change the visibility of or delete it.',
  })
  canManage!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Products the filter matches now. Only the first 12 filters of the list are counted; null ' +
      'for the rest, and in the answer of a create or update.',
  })
  count!: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class SavedFilterLimitsDto {
  @ApiProperty({ example: MAX_SAVED_FILTERS_PER_OWNER })
  perOwner!: number;

  @ApiProperty({ example: MAX_SHARED_SAVED_FILTERS })
  shared!: number;
}

export class SavedFilterListDto {
  @ApiProperty({ type: [SavedFilterDto] })
  items!: SavedFilterDto[];

  @ApiProperty({ description: 'Whether the caller may save a filter for everyone.' })
  canShare!: boolean;

  @ApiProperty({ type: SavedFilterLimitsDto })
  limits!: SavedFilterLimitsDto;
}

export class SavedFilterDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
}
