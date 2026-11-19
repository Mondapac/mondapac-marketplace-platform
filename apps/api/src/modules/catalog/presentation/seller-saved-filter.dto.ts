import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OWN_LISTED_STATUSES,
  OWN_PRODUCT_SORTS,
  OWN_PRODUCT_VIEWS,
} from '../application/use-cases/own-products-list.use-case';
import { SELLER_SAVED_FILTER_LIST_KEYS } from '../application/use-cases/own-saved-filters-list.use-case';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  SAVED_FILTER_NAME_MAX,
  SAVED_FILTER_VISIBILITIES,
} from '../domain/saved-filter';

// The requests and answers of the saved filters of the seller Products list (catalog design 9.2d).

export class SellerSavedFilterPayloadDto {
  @ApiProperty({ enum: [1], description: 'The version of the document.' })
  v!: number;

  @ApiProperty({ enum: OWN_PRODUCT_VIEWS, description: 'The tab the filter opens on.' })
  view!: string;

  @ApiPropertyOptional({ description: 'The search text; up to 100 characters.' })
  q?: string;

  @ApiPropertyOptional({ enum: OWN_LISTED_STATUSES })
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Only paused (true) or only not paused (false) products.' })
  paused?: boolean;

  @ApiPropertyOptional()
  typeCode?: string;

  @ApiProperty({ enum: OWN_PRODUCT_SORTS })
  sort!: string;

  @ApiProperty({ enum: ['asc', 'desc'] })
  direction!: string;
}

/** The request form of the document: the tab, sort and direction default as the list does. */
export class SellerSavedFilterRequestPayloadDto {
  @ApiProperty({ enum: [1], description: 'The version of the document.' })
  v!: number;

  @ApiPropertyOptional({ enum: OWN_PRODUCT_VIEWS, description: 'Default: all.' })
  view?: string;

  @ApiPropertyOptional({ description: 'The search text; up to 100 characters.' })
  q?: string;

  @ApiPropertyOptional({ enum: OWN_LISTED_STATUSES })
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  categoryId?: string;

  @ApiPropertyOptional()
  paused?: boolean;

  @ApiPropertyOptional()
  typeCode?: string;

  @ApiPropertyOptional({ enum: OWN_PRODUCT_SORTS, description: 'Default: updated.' })
  sort?: string;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    description: 'Default: asc for the name sort, else desc.',
  })
  direction?: string;
}

export class SellerSavedFilterCreateRequest {
  @ApiProperty({
    enum: SELLER_SAVED_FILTER_LIST_KEYS,
    description: 'The list the filter belongs to.',
  })
  listKey!: string;

  @ApiProperty({
    maxLength: SAVED_FILTER_NAME_MAX,
    description: 'Trimmed, 1 to 60 characters, no control character; one per member and list.',
  })
  name!: string;

  @ApiProperty({
    enum: SAVED_FILTER_VISIBILITIES,
    description: 'me, or everyone in the store (needs catalog.own-saved-filter.share).',
  })
  visibility!: string;

  @ApiProperty({ type: SellerSavedFilterRequestPayloadDto })
  payload!: SellerSavedFilterRequestPayloadDto;
}

export class SellerSavedFilterUpdateRequest {
  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX })
  name!: string;

  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES })
  visibility!: string;
}

export class SellerSavedFilterDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: SELLER_SAVED_FILTER_LIST_KEYS })
  listKey!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES })
  visibility!: string;

  @ApiProperty({ type: SellerSavedFilterPayloadDto })
  payload!: SellerSavedFilterPayloadDto;

  @ApiProperty({ description: 'True for the caller’s own filter.' })
  ownedByMe!: boolean;

  @ApiProperty({
    description: 'Whether the caller may rename, change the visibility of or delete it.',
  })
  canManage!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class SellerSavedFilterLimitsDto {
  @ApiProperty({ example: MAX_SAVED_FILTERS_PER_OWNER })
  perOwner!: number;

  @ApiProperty({ example: MAX_SHARED_SAVED_FILTERS })
  shared!: number;
}

export class SellerSavedFilterListDto {
  @ApiProperty({ type: [SellerSavedFilterDto] })
  items!: SellerSavedFilterDto[];

  @ApiProperty({ description: 'Whether the caller may save a filter for the whole store.' })
  canShare!: boolean;

  @ApiProperty({ type: SellerSavedFilterLimitsDto })
  limits!: SellerSavedFilterLimitsDto;
}

export class SellerSavedFilterDeletedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
}
