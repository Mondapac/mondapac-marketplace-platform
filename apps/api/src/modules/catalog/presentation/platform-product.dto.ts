import { ApiProperty } from '@nestjs/swagger';
import {
  OwnProductForm,
  OwnProductOptionsLocales,
  OwnVariantView,
  OwnWorkingCopyView,
} from './own-reads.dto';

// Bodies and answers of the platform product routes (catalog design 4.2, 8.2; CAT-10, CAT-41;
// slice 6). Ids and codes only: an answer never carries a text the admin typed, except in the
// content the admin sent in the same request.

const UUID = 'A UUID v7.';

export class PlatformProductCreateRequest {
  @ApiProperty({
    description:
      "The product type, one of the Market's catalog.productTypes. Nothing else is read: " +
      'scope, owner, Market, family, status and code come from the server.',
  })
  typeCode!: string;
}

export class PlatformProductCreated {
  @ApiProperty({ format: 'uuid', description: UUID })
  productId!: string;

  @ApiProperty({ description: '`P` and eight digits.', example: 'P00000001' })
  productCode!: string;

  @ApiProperty({
    type: [String],
    description: "A Simple product's one variant; empty for a Configurable one.",
  })
  variantIds!: string[];
}

export class PlatformProductSaveDraftRequest {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The draft content: the closed shape of the working copy. A key, locale or nesting it ' +
      'does not name refuses the whole save (working-copy.invalid-content).',
  })
  content!: Record<string, unknown>;

  @ApiProperty({
    type: 'array',
    items: { type: 'string', format: 'uuid', nullable: true },
    description:
      "The draft's variant list in order: a variant id the server minted, or null for a new " +
      'variant. At most 500.',
  })
  variantIds!: (string | null)[];
}

export class RefusedFieldView {
  @ApiProperty({ description: 'The checked field, for example `platform-product.title`.' })
  field!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The item inside the field, if any.' })
  ref!: string | null;

  @ApiProperty({ description: 'The locale of the text.' })
  locale!: string;

  @ApiProperty({
    enum: [
      'claim-text.found',
      'claim-text.check-unavailable',
      'text.invisible-character',
      'text.blocked-term',
    ],
    description:
      'Why the text kept its last saved value. A certification-like claim in product text is ' +
      'refused: a claim is made through a certificate, never in free text. text.blocked-term: ' +
      "the text holds a term of the Market's content filter.",
  })
  code!: string;

  @ApiProperty({
    required: false,
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'claim-text.found: the matched claim types and where.',
  })
  hits?: readonly unknown[];

  @ApiProperty({ required: false, description: 'text.invisible-character: the offset.' })
  offset?: number;

  @ApiProperty({ required: false, enum: ['ZWNJ', 'ZWJ', 'other'] })
  character?: string;
}

export class VariantNoticeView {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ enum: ['gtin.duplicate'] })
  code!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The public code of the PLATFORM product that already carries this GTIN, so the seller can ' +
      'sell on it; null when the GTIN is on any other product (no name, id or seller is given).',
  })
  sellOnProductCode!: string | null;
}

export class PlatformProductDraftSaved {
  @ApiProperty({ type: [String], description: 'The draft variant list, in order.' })
  variantIds!: string[];

  @ApiProperty({
    type: [RefusedFieldView],
    description: 'Texts that kept their last saved value; everything else was saved.',
  })
  refusedFields!: RefusedFieldView[];

  @ApiProperty({
    type: [VariantNoticeView],
    description:
      'Advice about the saved variants (a GTIN another product carries). Never a refusal.',
  })
  variantNotices!: VariantNoticeView[];
}

export class PlatformProductSubmitRequest {
  @ApiProperty({
    description: 'Whether a pending revision may be replaced by this one.',
    type: Boolean,
  })
  replacePending!: boolean;
}

export class PlatformProductSubmitted {
  @ApiProperty({ format: 'uuid' })
  revisionId!: string;

  @ApiProperty({ description: 'The revision number, from 1.' })
  revisionNo!: number;

  @ApiProperty({ description: "An admin's revision publishes at once." })
  published!: boolean;
}

export class PlatformProductDiscarded {
  @ApiProperty({ format: 'uuid' }) productId!: string;
}

export class PlatformProductOptionsView {
  @ApiProperty({ type: [String], description: 'The product types the Market offers.' })
  productTypes!: string[];
  @ApiProperty({ type: OwnProductOptionsLocales }) locales!: OwnProductOptionsLocales;
}

export class PlatformRevisionView {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The frozen content.' })
  content!: Record<string, unknown>;
}

export class PlatformProductOffers {
  @ApiProperty({ description: 'Sellers that hold at least one Offer on the product.' })
  sellerCount!: number;
  @ApiProperty({ description: 'Offers on the product that are not deleted, every seller.' })
  offerCount!: number;
}

export class PlatformProductView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 'P00000001' }) productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() familyCode!: string;
  @ApiProperty({ description: 'single (one fixed variant) or configurable.' })
  variantModel!: string;
  @ApiProperty() status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'When an admin paused the product (ISO 8601, UTC); null when it is not paused.',
  })
  pausedAt!: string | null;
  @ApiProperty({ type: PlatformProductOffers }) offers!: PlatformProductOffers;
  @ApiProperty({ type: [OwnVariantView] }) variants!: OwnVariantView[];
  @ApiProperty({ description: "The Market's cap on non-retired variants." }) maxVariants!: number;
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: OwnProductForm }) form!: OwnProductForm;
  @ApiProperty({ type: OwnProductOptionsLocales }) locales!: OwnProductOptionsLocales;
  @ApiProperty({ nullable: true, type: OwnWorkingCopyView })
  workingCopy!: OwnWorkingCopyView | null;
  @ApiProperty({ nullable: true, type: PlatformRevisionView })
  published!: PlatformRevisionView | null;
}

/** The error format `{ statusCode, code, details? }`: codes only, never a text of the request. */
export class ApiErrorBody {
  @ApiProperty()
  statusCode!: number;

  @ApiProperty({ description: 'A stable machine code, for example `claim-text.refused`.' })
  code!: string;

  @ApiProperty({
    required: false,
    type: Object,
    description: 'Per code: fields, issues, retryAfterSeconds, max (variant.limit-reached).',
  })
  details?: Record<string, unknown>;
}
