import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Bodies of the storefront search route. Ids, text and categories only: a certification badge
// is never part of a search result (it comes from `evaluateClaim`, never from indexed text).

export class ProductSearchItemBody {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'The published name in the Market default locale.' })
  name!: string;
  @ApiProperty({ nullable: true, type: String }) shortText!: string | null;
  @ApiProperty({ type: [String], description: 'Platform category ids of the product.' })
  categoryIds!: string[];
}

export class ProductSearchPageBody {
  @ApiProperty({ type: [ProductSearchItemBody], description: 'In rank order for a text query.' })
  items!: ProductSearchItemBody[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({
    description:
      'True when the result after this page is visible; hidden matches never change it, so it ' +
      'can be false while a later page still has items. A page can hold fewer than pageSize ' +
      'items when some hits are no longer sellable.',
  })
  hasMore!: boolean;
}

export class SearchQueryParams {
  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Words to search for (web-search syntax: quotes, OR, -). Omit to browse a category.',
  })
  q?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'A platform category id.' })
  category?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 1 }) page?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 48, default: 24 }) pageSize?: number;
}

// Bodies of the two shelf routes (storefront reads package).

export class ShelfPageBody {
  @ApiProperty({
    type: [ProductSearchItemBody],
    description: 'In shelf order. Fewer than `limit` items when not enough are sellable.',
  })
  items!: ProductSearchItemBody[];
}

export class MoneyBody {
  @ApiProperty({ description: 'Minor units, as a decimal string.', example: '1299' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217 code.' }) currency!: string;
}

export class SpecialItemBody extends ProductSearchItemBody {
  @ApiProperty({ format: 'uuid', description: 'The Variant the special is on.' })
  variantId!: string;
  @ApiProperty({ type: MoneyBody, description: 'The price a buyer pays now (the special).' })
  price!: MoneyBody;
  @ApiProperty({ type: MoneyBody, description: 'The regular price in force.' })
  regularPrice!: MoneyBody;
  @ApiProperty({ description: 'Whether both prices include tax.' }) taxInclusive!: boolean;
  @ApiProperty({ format: 'date-time', description: 'When the special ends (UTC).' })
  specialEndsAt!: string;
}

export class SpecialsPageBody {
  @ApiProperty({ type: [SpecialItemBody], description: 'Newest special first.' })
  items!: SpecialItemBody[];
}

// Body of the product page route (storefront reads package).

export class ProductDetailSpecialBody {
  @ApiProperty({ format: 'date-time', description: 'When the special ends (UTC).' })
  endsAt!: string;
}

export class ProductDetailStockBody {
  @ApiProperty({
    enum: ['in-stock', 'low', 'out'],
    description: 'The public stock state; the exact count is never shown.',
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'How many are left, set only when the status is `low`.',
  })
  onlyLeft!: number | null;
}

export class ProductDetailUnitBody {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The published Variant label.' })
  label!: string | null;
  @ApiProperty({ type: MoneyBody, description: 'The price a buyer pays now.' })
  price!: MoneyBody;
  @ApiProperty({ description: 'Whether the price includes tax.' }) taxInclusive!: boolean;
  @ApiProperty({
    type: ProductDetailSpecialBody,
    nullable: true,
    description: 'Set only while the price is a special.',
  })
  special!: ProductDetailSpecialBody | null;
  @ApiProperty({ type: ProductDetailStockBody }) stock!: ProductDetailStockBody;
}

export class ProductDetailSellerBody {
  @ApiProperty({ nullable: true, type: String, description: 'The seller public store name.' })
  storeName!: string | null;
  @ApiPropertyOptional({
    type: MoneyBody,
    nullable: true,
    description: 'The seller minimum order; null for none. Absent when it cannot be told.',
  })
  minimumOrder?: MoneyBody | null;
}

export class ProductDetailOfferBody {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ type: ProductDetailSellerBody }) seller!: ProductDetailSellerBody;
  @ApiProperty({
    type: [ProductDetailUnitBody],
    description: 'Priced Variants, in position order.',
  })
  units!: ProductDetailUnitBody[];
}

export class ProductDetailBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ description: 'The published name in the Market default locale.' })
  name!: string;
  @ApiProperty({ nullable: true, type: String }) shortDescription!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ type: [String], description: 'Platform category ids, in the revision order.' })
  categoryIds!: string[];
  @ApiProperty({
    type: [ProductDetailOfferBody],
    description: 'At least one Offer, lowest unit price first.',
  })
  offers!: ProductDetailOfferBody[];
}
