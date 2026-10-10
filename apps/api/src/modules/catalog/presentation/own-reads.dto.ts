import { ApiProperty } from '@nestjs/swagger';

// Answers of the seller read routes (catalog design 8.2, 9.2a). Ids, codes and the seller's own
// content only; instants are ISO 8601 strings in UTC.

export class OwnProductListItemView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 'P00000001' }) productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({
    description:
      'draft, unpublished, published, matched or retired (the discarded and withdrawn are not listed).',
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The draft name in the default locale.',
  })
  draftName!: string | null;
  @ApiProperty() hasPublishedRevision!: boolean;
  @ApiProperty() hasPendingRevision!: boolean;
  @ApiProperty({ nullable: true, type: String }) pendingSubmittedAt!: string | null;
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() createdAt!: string;
}

export class OwnProductList {
  @ApiProperty({ type: [OwnProductListItemView] }) items!: OwnProductListItemView[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Send as `afterId` for the next page; null on the last page.',
  })
  nextAfterId!: string | null;
}

export class OwnRevisionViewDto {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ enum: ['seller', 'admin'] }) authorKind!: string;
  @ApiProperty() sensitive!: boolean;
  @ApiProperty({ type: [String] }) sensitiveReasons!: string[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The frozen content.' })
  content!: Record<string, unknown>;
}

export class OwnWorkingCopyView {
  @ApiProperty({ type: 'object', additionalProperties: true }) content!: Record<string, unknown>;
  @ApiProperty() lastSavedAt!: string;
  @ApiProperty({ nullable: true, type: String }) baseRevisionId!: string | null;
}

export class OwnVariantView {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ description: 'proposed, published or retired.' }) state!: string;
}

export class OwnProductView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() familyCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [OwnVariantView] }) variants!: OwnVariantView[];
  @ApiProperty({ description: "The Market's cap on non-retired variants." }) maxVariants!: number;
  @ApiProperty({
    type: [String],
    description: 'Changes the Market sends to review, plus `images` (always).',
  })
  sensitiveFields!: string[];
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) pendingSubmittedAt!: string | null;
  @ApiProperty({ nullable: true, type: OwnWorkingCopyView })
  workingCopy!: OwnWorkingCopyView | null;
  @ApiProperty({ nullable: true, type: OwnRevisionViewDto }) published!: OwnRevisionViewDto | null;
  @ApiProperty({ nullable: true, type: OwnRevisionViewDto }) pending!: OwnRevisionViewDto | null;
}

export class OwnOfferProductLabel {
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) typeCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Published name, default locale.' })
  name!: string | null;
}

export class OwnOfferViewDto {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ type: OwnOfferProductLabel }) product!: OwnOfferProductLabel;
  @ApiProperty() sellerSku!: string;
  @ApiProperty() conditionCode!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  description!: Record<string, string>;
  @ApiProperty({
    description: 'draft, pending-first-publish, changes-needed or published.',
  })
  status!: string;
  @ApiProperty() listed!: boolean;
  @ApiProperty({ type: [String] }) offSaleCauses!: string[];
  @ApiProperty({ nullable: true, type: String }) handling!: string | null;
  @ApiProperty() attestationRecorded!: boolean;
  @ApiProperty({ nullable: true, type: String }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) firstPublishedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
}

export class OwnOfferList {
  @ApiProperty({ type: [OwnOfferViewDto] }) items!: OwnOfferViewDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Send as `afterId` for the next page; null on the last page.',
  })
  nextAfterId!: string | null;
}

export class OwnProductOptionsLocales {
  @ApiProperty() default!: string;
  @ApiProperty({ type: [String] }) supported!: string[];
}

export class OwnProductOptions {
  @ApiProperty({
    type: [String],
    description:
      'The product types the Market offers. Not yet narrowed to what the seller may sell: a create with a type the seller may not sell answers 422 type.not-allowed.',
  })
  productTypes!: string[];
  @ApiProperty({ type: [String], description: 'The condition codes an Offer may carry.' })
  conditions!: string[];
  @ApiProperty({ type: OwnProductOptionsLocales })
  locales!: OwnProductOptionsLocales;
  @ApiProperty({
    description:
      'False when the Market does not let sellers create products (the form should not open).',
  })
  sellerCanCreateProduct!: boolean;
  @ApiProperty({ type: [String], description: 'Statuses a seller sees on products in lists.' })
  productStatuses!: string[];
  @ApiProperty({ type: [String], description: 'Statuses a seller sees on Offers in lists.' })
  offerStatuses!: string[];
}
