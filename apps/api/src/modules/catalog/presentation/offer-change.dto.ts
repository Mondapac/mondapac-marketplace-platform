import { ApiProperty } from '@nestjs/swagger';
import { OFFER_HANDLINGS } from '../domain/offer-handling';
import {
  OFFER_CHANGE_FIELDS,
  OFFER_CHANGE_SUPERSEDED_CAUSES,
  OFFER_PENDING_CHANGE_STATUSES,
} from '../domain/offer-pending-change';
import { OFFER_REVIEW_REASONS } from '../domain/offer-review-policy';

// Bodies and answers of the held changes of live Offers (risk-based Offer approval, slice 2c).
// Ids, codes, the seller's own proposed content and the reviewer's note to the seller.

export class OfferChangeViewDto {
  @ApiProperty({ format: 'uuid' }) changeId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ enum: OFFER_PENDING_CHANGE_STATUSES }) status!: string;
  @ApiProperty({
    enum: OFFER_CHANGE_FIELDS,
    isArray: true,
    description: 'The watched fields the change holds.',
  })
  fields!: string[];
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    nullable: true,
    description: 'The whole held description (locale to text); null when not part of the change.',
  })
  proposedDescription!: Record<string, string> | null;
  @ApiProperty({ enum: OFFER_HANDLINGS, nullable: true, type: String })
  proposedHandling!: string | null;
  @ApiProperty({ type: [String], description: 'Requested certification type codes.' })
  proposedTagTypes!: string[];
  @ApiProperty({ enum: OFFER_REVIEW_REASONS, isArray: true, description: 'Never empty.' })
  reasons!: string[];
  @ApiProperty() policyVersion!: number;
  @ApiProperty({ description: 'The Offer version the change was made against.' })
  baseOfferVersion!: number;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The reviewer's note to the seller (request changes, reject; optional on approve).",
  })
  decisionNote!: string | null;
  @ApiProperty({ enum: OFFER_CHANGE_SUPERSEDED_CAUSES, nullable: true, type: String })
  supersededCause!: string | null;
}

export class OfferChangeListItemDto extends OfferChangeViewDto {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
}

export class OfferChangesListDto {
  @ApiProperty({ type: [OfferChangeListItemDto] }) items!: OfferChangeListItemDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Send as afterId for the next page; null on the last page.',
  })
  nextAfterId!: string | null;
}

export class OfferChangeApproveRequest {
  @ApiProperty({
    required: false,
    description: 'An optional note to the seller: 1 to 2000 characters, not only spaces.',
  })
  note?: string;
}

export class OfferChangeDecisionRequest {
  @ApiProperty({ description: 'The note to the seller: 1 to 2000 characters, not only spaces.' })
  note!: string;
}

export class OfferChangeDecidedDto {
  @ApiProperty({ format: 'uuid' }) changeId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ enum: OFFER_PENDING_CHANGE_STATUSES }) status!: string;
}

export class OfferChangeApprovedDto extends OfferChangeDecidedDto {
  @ApiProperty({ enum: OFFER_CHANGE_FIELDS, isArray: true, description: 'Live now.' })
  fields!: string[];
}
