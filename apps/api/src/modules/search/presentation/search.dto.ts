import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Bodies of the storefront search route. Ids, text and categories only: a certification badge
// is never part of a search result (it comes from `evaluateClaim`, never from indexed text).

export class ProductImageRefBody {
  @ApiProperty({
    format: 'uuid',
    description:
      'The photo id. The storefront builds the URL by code: ' +
      '`GET /catalog/public-images/{market}/{productId}/{imageId}/{thumb|medium|large}`.',
  })
  imageId!: string;
  @ApiProperty({ description: 'Pixel width of the largest rendition (the ratio holds for all).' })
  width!: number;
  @ApiProperty({ description: 'Pixel height of the largest rendition.' }) height!: number;
  @ApiProperty({ description: 'Text for `alt`: the product name in the Market default locale.' })
  alt!: string;
}

export class ProductSearchItemBody {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'The published name in the Market default locale.' })
  name!: string;
  @ApiProperty({ nullable: true, type: String }) shortText!: string | null;
  @ApiProperty({ type: [String], description: 'Platform category ids of the product.' })
  categoryIds!: string[];
  @ApiProperty({
    type: ProductImageRefBody,
    nullable: true,
    description:
      'The first public photo of the product (published revision, not taken down), or null.',
  })
  primaryImage!: ProductImageRefBody | null;
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
  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 50,
    description:
      "A store address (slug): lists that store's Offers by name. Not with `q`; may combine with " +
      '`category`. An unknown, retired or not-selling store answers an empty page.',
  })
  store?: string;
  @ApiPropertyOptional({
    maxLength: 80,
    description:
      "A brand address (slug): lists that brand's Offers by name. Not with `q` or `store`; may " +
      'combine with `category`. An unknown, draft or archived brand answers an empty page.',
  })
  brand?: string;
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

export class ProductDetailBadgeBody {
  @ApiProperty({ description: 'The certification type code, as configured (never a fixed list).' })
  typeCode!: string;
  @ApiProperty({ description: 'The type name in the Market default locale.' })
  typeName!: string;
  @ApiProperty({ enum: ['SELLER', 'MANUFACTURER'] }) basis!: 'SELLER' | 'MANUFACTURER';
  @ApiProperty({
    description: "True when this is the seller's own declaration, not a certificate.",
  })
  sellerClaim!: boolean;
  @ApiProperty({ nullable: true, type: String }) issuerName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'ISO calendar date (YYYY-MM-DD) the certificate is valid until, or null.',
  })
  validUntilLocalDate!: string | null;
  @ApiProperty() verifiedWithIssuer!: boolean;
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
  @ApiProperty({
    type: [ProductDetailBadgeBody],
    description:
      'Certification badges of this Offer, decided live by certification when the page is ' +
      'requested; empty when there is none or they cannot be had. Never an ID, certificate ' +
      'number, document or link.',
  })
  badges!: ProductDetailBadgeBody[];
}

export class ProductDetailBrandBody {
  @ApiProperty({ description: 'The brand page slug: `/brands/{slug}` on the storefront.' })
  slug!: string;
  @ApiProperty() name!: string;
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
    type: ProductDetailBrandBody,
    nullable: true,
    description: "The product's brand while it is active; null for none.",
  })
  brand!: ProductDetailBrandBody | null;
  @ApiProperty({
    type: [ProductImageRefBody],
    description:
      'Public photos in the published revision order (the first is the main one); at most 8.',
  })
  images!: ProductImageRefBody[];
  @ApiProperty({
    type: [ProductDetailOfferBody],
    description: 'At least one Offer, lowest unit price first.',
  })
  offers!: ProductDetailOfferBody[];
}
