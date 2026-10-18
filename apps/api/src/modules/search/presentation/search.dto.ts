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
