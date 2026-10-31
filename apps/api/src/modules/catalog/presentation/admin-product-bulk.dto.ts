import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ADMIN_PRODUCT_VIEWS,
  LISTED_STATUSES,
} from '../application/use-cases/admin-products-list.use-case';
import { BULK_ACTIONS, BULK_MAX_IDS } from '../application/use-cases/admin-products-bulk.use-case';
import { PRODUCT_SCOPES } from '../domain/product';

// The request and answer of the admin product bulk action (catalog design 9.2c).

export class AdminProductSelectorDto {
  @ApiPropertyOptional({ enum: ADMIN_PRODUCT_VIEWS, description: 'The tab; default active.' })
  view?: string;

  @ApiPropertyOptional({ description: 'Up to 100 characters; as the list reads `q`.' })
  q?: string;

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

export class AdminProductBulkRequest {
  @ApiProperty({ enum: BULK_ACTIONS, description: 'pause = Deactivate, resume = Activate.' })
  action!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: BULK_MAX_IDS,
    description: 'The products, 1 to 200. Exactly one of productIds and selector.',
  })
  productIds?: string[];

  @ApiPropertyOptional({
    type: AdminProductSelectorDto,
    description: 'All products of a tab, search and filters ("Select all N in this filter").',
  })
  selector?: AdminProductSelectorDto;

  @ApiPropertyOptional({
    description:
      'delete only: the Offers on the PLATFORM products that would be retired, as the dry run ' +
      'answered (confirmOfferCount). Required when there are such products.',
  })
  confirmOfferCount?: number;

  @ApiPropertyOptional({ description: 'true: change nothing and answer what the action would do.' })
  dryRun?: boolean;
}

export class AdminProductBulkItemDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ enum: ['done', 'skipped', 'failed'] })
  outcome!: string;

  @ApiPropertyOptional({
    description:
      'A stable code: for skipped, the state that makes the action a no-op (product.already-paused, ' +
      'product.not-paused, product.not-published, product.not-withdrawable, access.denied); for ' +
      'failed, what stopped it (conflict.retry, claim.check-unavailable, retire.count-changed, ...).',
  })
  reason?: string;
}

export class AdminProductBulkCountsDto {
  @ApiProperty() done!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty() failed!: number;
}

export class AdminProductBulkDto {
  @ApiProperty({ enum: BULK_ACTIONS })
  action!: string;

  @ApiProperty()
  dryRun!: boolean;

  @ApiProperty({ description: 'Products the request resolved to.' })
  requested!: number;

  @ApiProperty({ description: 'Products the action would change (dry run) or changed.' })
  eligible!: number;

  @ApiProperty({
    description: 'delete: the Offers on the PLATFORM products that would be retired.',
  })
  confirmOfferCount!: number;

  @ApiProperty({
    description: 'delete: the Offers of every product that would be ended or retired.',
  })
  affectedOfferCount!: number;

  @ApiProperty({ type: AdminProductBulkCountsDto })
  counts!: AdminProductBulkCountsDto;

  @ApiProperty({ type: [AdminProductBulkItemDto], description: 'Empty on a dry run.' })
  results!: AdminProductBulkItemDto[];
}
