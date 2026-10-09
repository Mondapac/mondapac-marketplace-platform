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
