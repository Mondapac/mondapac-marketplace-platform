import { ApiProperty } from '@nestjs/swagger';
import { PRODUCT_SCOPES } from '../domain/product';
import { LISTED_STATUSES } from '../application/use-cases/admin-products-list.use-case';

// The answer of the admin product list (catalog design 8.2, 9.2 `admin-products.list`). Ids, codes
// and names only: no price and no stock.

export class AdminProductRowDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ description: 'The Market-unique product code.' })
  productCode!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The name in the Market default locale (published revision, else pending).',
  })
  name!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'The primary photo of that revision. Serve it with ' +
      'GET catalog/admin/products/{productId}/images/{primaryImageId}/thumb.',
  })
  primaryImageId!: string | null;

  @ApiProperty({ enum: PRODUCT_SCOPES })
  scope!: string;

  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'Null for PLATFORM.' })
  ownerSellerId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The owner public store name; null for PLATFORM or when sellers cannot say.',
  })
  ownerStoreName!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  categoryId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The first category of the shown revision, in the Market default locale.',
  })
  categoryName!: string | null;

  @ApiProperty()
  typeCode!: string;

  @ApiProperty({ enum: LISTED_STATUSES })
  status!: string;

  @ApiProperty({ description: 'Offers of the product that are not deleted, of every seller.' })
  offerCount!: number;

  @ApiProperty({ format: 'date-time', description: 'The last change of the product root.' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AdminProductViewCountsDto {
  @ApiProperty() active!: number;
  @ApiProperty() all!: number;
  @ApiProperty() inactive!: number;
}

export class AdminProductListDto {
  @ApiProperty({ type: [AdminProductRowDto] })
  items!: AdminProductRowDto[];

  @ApiProperty({ description: 'Products matching the view and the filters, over all pages.' })
  total!: number;

  @ApiProperty() page!: number;

  @ApiProperty() pageSize!: number;

  @ApiProperty({
    type: AdminProductViewCountsDto,
    description: 'Per tab, for the same search and filters.',
  })
  counts!: AdminProductViewCountsDto;
}
