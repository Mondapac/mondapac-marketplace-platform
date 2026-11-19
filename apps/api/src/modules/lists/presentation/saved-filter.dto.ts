import { ApiProperty } from '@nestjs/swagger';
import { MAX_SAVED_FILTERS_PER_OWNER } from '../contracts';
import { SAVED_FILTER_NAME_MAX, SAVED_FILTER_VISIBILITIES } from '../domain/saved-filter-rules';

// The requests and answers of the generic saved filters of the admin lists (super list B0-1b).
// The payload is a closed document the owning module defines for its list.

export class SavedFilterCreateRequest {
  @ApiProperty({ description: 'The list the filter belongs to, e.g. admin.catalog.products.' })
  listKey!: string;

  @ApiProperty({
    maxLength: SAVED_FILTER_NAME_MAX,
    description: 'Trimmed, 1 to 60 characters, no control character; one per owner and list.',
  })
  name!: string;

  @ApiProperty({
    enum: SAVED_FILTER_VISIBILITIES,
    description: 'me, or everyone (needs the list’s share permission).',
  })
  visibility!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The closed document of the list: its tab, search, filters, sort and columns. The ' +
      'certification and sellers lists (admin.certification.issuer-requests, ' +
      'admin.certification.review-queue, admin.sellers.list, admin.sellers.health-queue) use ' +
      '{ v: 1, view, filters?, sort?, direction?: asc | desc }; an unknown key or word is a 400.',
  })
  payload!: Record<string, unknown>;
}

export class SavedFilterUpdateRequest {
  @ApiProperty({ description: 'The list the filter belongs to.' })
  listKey!: string;

  @ApiProperty({ maxLength: SAVED_FILTER_NAME_MAX })
  name!: string;

  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES })
  visibility!: string;
}

export class SavedFiltersReorderRequest {
  @ApiProperty({ description: 'The list whose filters are reordered.' })
  listKey!: string;

  @ApiProperty({
    type: [String],
    description:
      `Every filter the caller owns in the list, once each, in the new order (at most ` +
      `${MAX_SAVED_FILTERS_PER_OWNER}).`,
  })
  ids!: string[];
}

export class SavedFilterDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() listKey!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SAVED_FILTER_VISIBILITIES }) visibility!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) payload!: Record<string, unknown>;
  @ApiProperty({ description: 'True for the caller’s own filter.' }) ownedByMe!: boolean;
  @ApiProperty({ description: 'Whether the caller may rename, share or delete it.' })
  canManage!: boolean;
  @ApiProperty() position!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SavedFilterListDto {
  @ApiProperty() listKey!: string;
  @ApiProperty({ type: [SavedFilterDto] }) items!: SavedFilterDto[];
  @ApiProperty({ description: 'Whether the caller holds the list’s share permission.' })
  canShare!: boolean;
}

export class SavedFilterDeletedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
}

export class SavedFiltersReorderedDto {
  @ApiProperty() listKey!: string;
  @ApiProperty({ type: [String] }) ids!: string[];
}
