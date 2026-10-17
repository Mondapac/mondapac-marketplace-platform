import { ApiProperty } from '@nestjs/swagger';

// Body and answer of the seller Offer routes (catalog design 4.4, 8.2; OFR-02, OFR-03; slice 7a-3).
// Ids and codes only. The one exception is a refused unknown key: it is cut and sanitised, and
// the panel renders it as text only.

export class OwnOfferCreateRequest {
  @ApiProperty({ format: 'uuid', description: 'A published PLATFORM product. A UUID v7.' })
  productId!: string;

  @ApiProperty({
    description: "The seller's own SKU, unique among the seller's open Offers (CAT-10).",
  })
  sellerSku!: string;

  @ApiProperty({ description: "One of the Market's catalog.conditions." })
  conditionCode!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      "Locale to text, in the Market's supported locales; at most 20 locales and 5,000 " +
      'characters each. May be empty. Handling, attestation, tags, seller and status are never ' +
      'accepted: the seller comes from the session and the Offer starts as a draft.',
  })
  description!: Record<string, string>;
}

export class OwnOfferCreated {
  @ApiProperty({ format: 'uuid', description: 'The new draft Offer. A UUID v7.' })
  offerId!: string;
}

export class OwnOfferEditRequest {
  @ApiProperty({
    description: "The seller's own SKU, unique among the seller's open Offers (CAT-10).",
  })
  sellerSku!: string;

  @ApiProperty({ description: "One of the Market's catalog.conditions." })
  conditionCode!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      "The whole description: locale to text, in the Market's supported locales; at most 20 " +
      'locales and 5,000 characters each. May be empty. Handling, attestation, tags, seller and ' +
      'status are never accepted. An Offer waiting for review or needing changes returns to draft.',
  })
  description!: Record<string, string>;
}

export class OwnOfferEdited {
  @ApiProperty({
    type: [String],
    description:
      'Field ids that changed (sellerSku, conditionCode, description); empty when the form ' +
      'matched what was stored.',
  })
  changedFields!: string[];
}

export class OwnOfferSetHandlingRequest {
  @ApiProperty({
    enum: ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'],
    description:
      'How the goods are handled. Needed before the Offer can be submitted. An Offer waiting ' +
      'for review or needing changes returns to draft.',
  })
  handling!: string;
}

export class OwnOfferHandlingSet {
  @ApiProperty({
    type: [String],
    description: "['handling'] when the value changed; empty when the Offer already held it.",
  })
  changedFields!: string[];
}

export class OwnOfferRecordAttestationRequest {
  @ApiProperty({
    description:
      "true records the seller's attestation that the Offer's stock is genuine, sealed and " +
      'unaltered (needed for a manufacturer-certified badge; the handling must be ' +
      'SEALED_ORIGINAL); false withdraws it. Who and when come from the session and the clock, ' +
      'never from the request.',
  })
  attested!: boolean;
}

export class OwnOfferAttestationRecorded {
  @ApiProperty({
    type: [String],
    description: "['attestation'] when the record changed; empty when the Offer already held it.",
  })
  changedFields!: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the recorded attestation was made (the first record is kept); null when none.',
  })
  attestationRecordedAt!: string | null;
}

export class OwnOfferSubmitted {
  @ApiProperty({
    description: 'True when the Offer is published at once; false when it waits for review.',
  })
  published!: boolean;
}

export class OwnOfferSubmitRequest {
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Certification type codes to tag at this submit (at most 20, distinct, active types of the ' +
      'Market). Each is asked of certification against the published revision; one not allowed ' +
      'refuses the whole submit (claim.requested-tag-not-allowed, details.tags). The body may be ' +
      'absent. No decision, basis, certificate or status is ever accepted.',
  })
  requestedTags?: string[];
}

export class OwnOfferAddTagRequest {
  @ApiProperty({
    description:
      'A certification type code, an active type of the Market. Only the code: no decision, ' +
      'basis, certificate, issuer or status is accepted (they come from certification).',
  })
  typeCode!: string;
}

export class OwnOfferSellWithoutBadgeRequest {
  @ApiProperty({
    enum: [true],
    description:
      'The explicit "sell without this badge" confirmation (catalog design 5.3); must be true. ' +
      'The suspended tag is removed and the Offer is listed again without the badge.',
  })
  confirmSellWithoutBadge!: boolean;
}

export class OwnOfferTagAdded {
  @ApiProperty() typeCode!: string;
  @ApiProperty({ enum: ['active'] }) status!: string;
  @ApiProperty({ enum: ['SELLER', 'MANUFACTURER'], description: 'The basis of the tag (CERT-24).' })
  basis!: string;
}

export class OwnProductCreateRequest {
  @ApiProperty({
    description:
      "The product type, one of the Market's catalog.productTypes and one the seller may sell.",
  })
  typeCode!: string;

  @ApiProperty({
    description: "The seller's own SKU, unique among the seller's open Offers (CAT-10).",
  })
  sellerSku!: string;

  @ApiProperty({ description: "One of the Market's catalog.conditions." })
  conditionCode!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      "Locale to text, in the Market's supported locales; at most 20 locales and 5,000 " +
      'characters each. May be empty. It is the Offer description; the product is made with it.',
  })
  description!: Record<string, string>;
}

export class OwnProductCreated {
  @ApiProperty({ format: 'uuid', description: 'The new draft product. A UUID v7.' })
  productId!: string;

  @ApiProperty({ description: '`P` and eight digits.', example: 'P00000001' })
  productCode!: string;

  @ApiProperty({
    type: [String],
    description: "A Simple product's one variant; empty for a Configurable one.",
  })
  variantIds!: string[];

  @ApiProperty({ format: 'uuid', description: "The seller's draft Offer on it. A UUID v7." })
  offerId!: string;
}
