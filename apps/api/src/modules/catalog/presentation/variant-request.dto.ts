import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the variant-request routes (variants plan, package V7). A request holds
// option codes only: nothing a seller typed.

export class RequestVariantRequest {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Variant attribute code to active option code, one entry per axis of the product.',
    example: { size: 'xl' },
  })
  optionValues!: Record<string, string>;
}

export class VariantRequestOpenedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['open'] }) status!: string;
  @ApiProperty() version!: number;
}

export class VariantRequestOptionBody {
  @ApiProperty() attributeCode!: string;
  @ApiProperty({ description: "The attribute's name in the Market's default locale." })
  attributeName!: string;
  @ApiProperty() optionCode!: string;
  @ApiProperty({ description: "The option's label in the Market's default locale." })
  optionLabel!: string;
}

export class VariantRequestLocalesBody {
  @ApiProperty() default!: string;
  @ApiProperty({ type: [String] }) supported!: string[];
}

export class VariantRequestExistingBody {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() variantNo!: number;
  @ApiProperty({ type: [VariantRequestOptionBody] }) options!: VariantRequestOptionBody[];
}

export class VariantRequestItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The version a decision must name.' }) version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) sellerName!: string | null;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ type: [VariantRequestOptionBody], description: 'What was asked for.' })
  options!: VariantRequestOptionBody[];
  @ApiProperty({
    type: [VariantRequestExistingBody],
    description: 'The variants the product has now, to map the request to.',
  })
  existing!: VariantRequestExistingBody[];
  @ApiProperty({ description: 'True when the product already has it: map, do not approve.' })
  alreadyExists!: boolean;
}

export class VariantRequestListBody {
  @ApiProperty({ type: [VariantRequestItemBody] }) items!: VariantRequestItemBody[];
  @ApiProperty({ type: VariantRequestLocalesBody }) locales!: VariantRequestLocalesBody;
}

export class VariantRequestApproveRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class VariantRequestMapRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ format: 'uuid', description: 'A variant of the product that is not retired.' })
  variantId!: string;
}

export class VariantRequestDeclineRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ description: 'The words the seller will read, 1 to 300 characters.' })
  reason!: string;
}

export class VariantRequestDecidedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['approved', 'mapped', 'declined'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) resolvedVariantId!: string | null;
}

export class VariantRequestDecisionWrapBody {
  @ApiProperty({ type: VariantRequestDecidedBody }) request!: VariantRequestDecidedBody;
}

export class OwnVariantRequestItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ enum: ['open', 'approved', 'mapped', 'declined'] }) status!: string;
  @ApiProperty({ type: [VariantRequestOptionBody] }) options!: VariantRequestOptionBody[];
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The variant created (approved) or matched (mapped).',
  })
  resolvedVariantId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The reviewer's words, for a declined request. Plain text.",
  })
  declineReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) decidedAt!: string | null;
}

export class OwnVariantRequestListBody {
  @ApiProperty({ type: [OwnVariantRequestItemBody] }) items!: OwnVariantRequestItemBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The afterId of the next page.' })
  nextAfterId!: string | null;
  @ApiProperty({ description: "How many of the seller's requests wait for a decision." })
  openCount!: number;
  @ApiProperty({ description: 'How many may wait at once.' }) maxOpen!: number;
}
