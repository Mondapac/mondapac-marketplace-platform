import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  SAVED_FILTER_LIST_KEYS,
  SAVED_FILTER_NAME_MAX,
  SAVED_FILTER_VISIBILITIES,
  SORT_IDS,
} from '../domain/saved-view';

// The requests and answers of the saved filters and the column choice of the order lists.

export { SAVED_FILTER_LIST_KEYS };

export class OrderFilterConditionsDto {
  @ApiPropertyOptional({ enum: ['none', 'authorised', 'captured', 'voided'] })
  paymentState?: string;

  @ApiPropertyOptional({ enum: ['to-ship', 'shipped', 'delivered'] })
  fulfilment?: string;

  @ApiPropertyOptional({ description: 'A calendar day (yyyy-mm-dd, UTC): placed or paid from it.' })
  from?: string;

  @ApiPropertyOptional({ description: 'A calendar day (yyyy-mm-dd, UTC), included.' })
  to?: string;
}

export class OrderFilterPayloadDto {
  @ApiProperty({ enum: [1] })
  v!: 1;

  @ApiProperty({
    description:
      'The tab: all or one status (admin: pending-payment, confirmed, cancelled; seller: to-ship, shipped, delivered).',
  })
  tab!: string;

  @ApiPropertyOptional({ type: OrderFilterConditionsDto })
  filters?: OrderFilterConditionsDto;

  @ApiPropertyOptional({ enum: SORT_IDS, description: 'Left out for newest first.' })
  sort?: string;
}

export class SavedFilterDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: SAVED_FILTER_LIST_KEYS }) listKey!: string;
  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX }) name!: string;
  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES }) visibility!: string;
  @ApiProperty({ type: OrderFilterPayloadDto }) payload!: OrderFilterPayloadDto;
  @ApiProperty() ownedByMe!: boolean;
  @ApiProperty() canManage!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SavedFilterLimitsDto {
  @ApiProperty({ example: MAX_SAVED_FILTERS_PER_OWNER }) perOwner!: number;
  @ApiProperty({ example: MAX_SHARED_SAVED_FILTERS }) shared!: number;
}

export class SavedFilterListDto {
  @ApiProperty({ type: [SavedFilterDto] }) items!: SavedFilterDto[];
  @ApiProperty({ description: 'Whether the caller may save a filter for everyone.' })
  canShare!: boolean;
  @ApiProperty({ type: SavedFilterLimitsDto }) limits!: SavedFilterLimitsDto;
}

export class SavedFilterCreateRequest {
  @ApiProperty({ enum: SAVED_FILTER_LIST_KEYS }) listKey!: string;
  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX }) name!: string;
  @ApiPropertyOptional({
    enum: SAVED_FILTER_VISIBILITIES,
    description: 'Required on the admin list; the seller list is always me.',
  })
  visibility?: string;
  @ApiProperty({ type: OrderFilterPayloadDto }) payload!: OrderFilterPayloadDto;
}

export class SavedFilterUpdateRequest {
  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX }) name!: string;
  @ApiPropertyOptional({
    enum: SAVED_FILTER_VISIBILITIES,
    description:
      'Required on the admin list (name and visibility are both given); left out on the seller list, which is always me.',
  })
  visibility?: string;
}

export class SavedFilterDeletedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
