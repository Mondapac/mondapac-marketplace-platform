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

export class SearchMoneyBody {
  @ApiProperty({ description: 'Whole minor units, as decimal text (e.g. "1299").' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217 code.' }) currency!: string;
}

export class SearchItemPriceBody {
  @ApiProperty({ type: SearchMoneyBody, description: 'The lowest buyer price.' })
  from!: SearchMoneyBody;
  @ApiProperty({ description: 'True when the matching variants differ in price: show "From".' })
  varies!: boolean;
}

export class SearchExactMatchBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
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

export class SearchResultItemBody extends ProductSearchItemBody {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'The variant to open (`/p/{productId}?v={variantId}`): the first matching in-stock variant ' +
      'by the owner order when a variant filter, `price` or an exact GTIN chose it; else null.',
  })
  variantId!: string | null;
  @ApiProperty({
    type: SearchItemPriceBody,
    nullable: true,
    description:
      'The lowest buyer price of the matching in-stock variants (all in-stock variants when ' +
      'nothing narrowed to a variant); null when none is in stock and priced.',
  })
  price!: SearchItemPriceBody | null;
  @ApiProperty({
    type: [ProductImageRefBody],
    description:
      'All public photos of the product in the published revision order (the first is `primaryImage`); at most 8, empty for none.',
  })
  images!: ProductImageRefBody[];
}

export class SearchFilterOptionBody {
  @ApiProperty({ description: 'The option code: use it in `filter`, never the label.' })
  code!: string;
  @ApiProperty({ description: 'The label in the Market default locale (English fallback).' })
  label!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Products this option would show; null when the scope was too large to count.',
  })
  count!: number | null;
  @ApiProperty({ description: 'Whether the request already picked it.' }) selected!: boolean;
}

export class SearchFilterBoundsBody {
  @ApiProperty({ description: 'Decimal text.' }) min!: string;
  @ApiProperty({ description: 'Decimal text.' }) max!: string;
}

export class SearchFilterPickedBody {
  @ApiProperty({ nullable: true, type: String }) min!: string | null;
  @ApiProperty({ nullable: true, type: String }) max!: string | null;
}

export class SearchFilterBody {
  @ApiProperty({ description: 'The attribute code, the `filter` or `range` name.' }) code!: string;
  @ApiProperty({ description: 'The attribute name in the Market default locale.' }) name!: string;
  @ApiProperty({
    enum: ['choice', 'range', 'toggle'],
    description:
      '`choice` (several values may be picked), `range` (a number between two bounds) or ' +
      '`toggle` (only yes: option code `true`). Show more after 8 options; zero-count values ' +
      'are not listed unless picked.',
  })
  kind!: 'choice' | 'range' | 'toggle';
  @ApiProperty({ type: [SearchFilterOptionBody] }) options!: SearchFilterOptionBody[];
  @ApiProperty({ type: SearchFilterBoundsBody, nullable: true, description: 'Range only.' })
  bounds!: SearchFilterBoundsBody | null;
  @ApiProperty({ type: SearchFilterPickedBody, nullable: true, description: 'Range only.' })
  picked!: SearchFilterPickedBody | null;
}

export class SearchCategoryCountBody {
  @ApiProperty({ description: 'A platform category right below the asked one.' })
  categoryId!: string;
  @ApiProperty({ description: 'Its public name.' }) name!: string;
  @ApiProperty({ description: 'Products of the scope in it or under it.' }) count!: number;
}

export class SearchCountsBody {
  @ApiProperty({ description: 'Products (one per product, never Offers) in the scope.' })
  total!: number;
  @ApiProperty({
    description: 'True when the scope was too large to count: `total` is then a lower bound.',
  })
  totalIsCapped!: boolean;
  @ApiProperty({
    type: [SearchCategoryCountBody],
    description:
      'The "In categories" lines: the categories right below the asked one (the top level when ' +
      'none), most products first, at most 12.',
  })
  categories!: SearchCategoryCountBody[];
  @ApiProperty({ description: 'Stores that have a product in the scope.' }) storeCount!: number;
}

export class ProductSearchPageBody {
  @ApiProperty({ type: [SearchResultItemBody], description: 'In rank order for a text query.' })
  items!: SearchResultItemBody[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({
    description:
      'True when the result after this page is visible; hidden matches never change it, so it ' +
      'can be false while a later page still has items. A page can hold fewer than pageSize ' +
      'items when some hits are no longer sellable.',
  })
  hasMore!: boolean;
  @ApiProperty({
    type: [SearchFilterBody],
    description:
      'The listing filters with counts (a category list: the admin-chosen filters; a text search: ' +
      'Brand and Country of origin). Empty for a store or brand list.',
  })
  filters!: SearchFilterBody[];
  @ApiProperty({
    description:
      'True when a filter narrowed the list. A filtered page is `noindex` with the canonical ' +
      'link to the unfiltered category.',
  })
  filtered!: boolean;
  @ApiProperty({ description: 'False when the scope was too large to count (counts are null).' })
  countsComplete!: boolean;
  @ApiProperty({
    type: SearchCountsBody,
    nullable: true,
    description:
      'The size of the query scope (text and category, before attribute filters and price), from ' +
      'the index without the query-time visibility check, so it can briefly include an Offer that ' +
      'just became unsellable. Null for a store or brand list, an exact GTIN hit, and when the ' +
      'category tree cannot be read.',
  })
  counts!: SearchCountsBody | null;
  @ApiProperty({
    type: SearchExactMatchBody,
    nullable: true,
    description:
      '`q` was exactly the GTIN of a published variant of a listed Offer, in stock or not (the ' +
      'product page shows its stock): go straight to that product page with `?v={variantId}`. ' +
      'Null otherwise, and on any page after the first.',
  })
  exactMatch!: SearchExactMatchBody | null;
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
  @ApiPropertyOptional({
    type: [String],
    description: 'Attribute filters, `<attribute>:<code>[,<code>...]`; see the route.',
  })
  filter?: string[];
  @ApiPropertyOptional({
    type: [String],
    description: 'Number ranges, `<attribute>:<min>..<max>`; see the route.',
  })
  range?: string[];
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

export class ProductDetailSpecificationValueBody {
  @ApiProperty({ enum: ['text', 'list', 'number', 'boolean', 'date', 'measure'] })
  kind!: 'text' | 'list' | 'number' | 'boolean' | 'date' | 'measure';
  @ApiPropertyOptional({ description: 'kind text: the text (a select label is in the locale).' })
  text?: string;
  @ApiPropertyOptional({ type: [String], description: 'kind list: option labels.' })
  items?: string[];
  @ApiPropertyOptional({
    description:
      'kind number: a decimal string; boolean: true or false; date: YYYY-MM-DD; measure: a ' +
      'decimal string in the unit the seller chose (see `unitLabel`).',
  })
  value?: string | boolean;
  @ApiPropertyOptional({
    description: "kind measure: the unit's label in the asked locale, else English (e.g. kg).",
  })
  unitLabel?: string;
}

export class ProductDetailSpecificationBody {
  @ApiProperty() code!: string;
  @ApiProperty({
    description:
      "The attribute name in the asked locale, else the Market's fallback locale (English).",
  })
  name!: string;
  @ApiProperty({ type: ProductDetailSpecificationValueBody })
  value!: ProductDetailSpecificationValueBody;
}

export class ProductDetailSpecificationGroupBody {
  @ApiProperty({ description: 'The family group code, e.g. details.' }) groupCode!: string;
  @ApiProperty({ type: [ProductDetailSpecificationBody] })
  specifications!: ProductDetailSpecificationBody[];
}

export class ProductDetailVariantImagesBody {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({
    type: [String],
    description:
      'The photo ids this Variant shows, main photo first. Each is one of the `images` of the ' +
      'product; build the URL like any photo.',
  })
  imageIds!: string[];
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
    type: [ProductDetailSpecificationGroupBody],
    description:
      'Attribute values the product page lists (not drafts, shown on the product page), grouped by family group in the family order; empty for none.',
  })
  specifications!: ProductDetailSpecificationGroupBody[];
  @ApiProperty({
    type: [ProductImageRefBody],
    description:
      'Public photos in the published revision order (the first is the main one); at most 8.',
  })
  images!: ProductImageRefBody[];
  @ApiProperty({
    type: [ProductDetailVariantImagesBody],
    description:
      'The photos of each Variant that picked some of the product photos; a Variant not listed shows the product photos. Never more than the product photos.',
  })
  variantImages!: ProductDetailVariantImagesBody[];
  @ApiProperty({
    type: [ProductDetailOfferBody],
    description: 'At least one Offer, lowest unit price first.',
  })
  offers!: ProductDetailOfferBody[];
}

export class StoreSearchItemBody {
  @ApiProperty({ description: 'The store address (`/s/<slug>` on the buyer site).' }) slug!: string;
  @ApiProperty({ description: 'The public store name of the approved revision.' }) name!: string;
  @ApiProperty({
    description:
      'Indexed (sellable) Offers of the store, one per product it sells; from the index, not ' +
      're-checked one by one.',
  })
  productCount!: number;
}

export class StoreSearchPageBody {
  @ApiProperty({ type: [StoreSearchItemBody], description: 'In rank order.' })
  items!: StoreSearchItemBody[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({
    description:
      'True when the next store is visible; hidden matches never change it, so it can be false ' +
      'while a later page still has items.',
  })
  hasMore!: boolean;
}

export class SuggestProductBody {
  @ApiProperty({
    format: 'uuid',
    description: 'The product page id (the same id as `productId` of `GET /search/products`).',
  })
  productId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'The public name of the store of the shown Offer.' })
  sellerName!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Null when no name can be read.' })
  categoryName!: string | null;
  @ApiProperty({
    type: ProductImageRefBody,
    nullable: true,
    description: 'The first public photo of the product, or null. No price, by rule.',
  })
  image!: ProductImageRefBody | null;
}

export class SuggestStoreBody {
  @ApiProperty({ description: 'The store address (`/s/<slug>` on the buyer site).' })
  storeSlug!: string;
  @ApiProperty({ description: 'The public store name.' }) name!: string;
  @ApiProperty({
    description: 'Indexed (sellable) Offers of the store, one per product it sells.',
  })
  productCount!: number;
}

export class SuggestBody {
  @ApiProperty({ type: [SuggestProductBody], description: 'At most 5, one per product.' })
  products!: SuggestProductBody[];
  @ApiProperty({ type: [SuggestStoreBody], description: 'At most 3.' })
  stores!: SuggestStoreBody[];
  @ApiProperty({
    description:
      'Products in the query scope, as `GET /search/products` counts them (from the index, without ' +
      'the query-time check); 0 for a `q` shorter than 2 characters.',
  })
  total!: number;
  @ApiProperty({ description: 'True when the scope was too large to count: `total` is a floor.' })
  totalIsCapped!: boolean;
}
