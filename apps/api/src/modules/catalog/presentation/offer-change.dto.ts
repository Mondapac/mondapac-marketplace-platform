import { ApiProperty } from '@nestjs/swagger';
import { OFFER_HANDLINGS } from '../domain/offer-handling';
import {
  OFFER_CHANGE_FIELDS,
  OFFER_CHANGE_SUPERSEDED_CAUSES,
  OFFER_PENDING_CHANGE_STATUSES,
} from '../domain/offer-pending-change';
import { OFFER_REVIEW_REASONS, SELLER_REVIEW_REASONS } from '../domain/offer-review-policy';
import { QueueSellerDto } from './offer-review.dto';

// Bodies and answers of the held changes of live Offers (risk-based Offer approval, slice 2c).
// Ids, codes, the seller's own proposed content and the reviewer's note to the seller.

/** What the admin and seller views of a held change share (no reasons). */
abstract class OfferChangeBaseDto {
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

/** A held change as the reviewer reads it: the full reason codes. */
export class OfferChangeViewDto extends OfferChangeBaseDto {
  @ApiProperty({ enum: OFFER_REVIEW_REASONS, isArray: true, description: 'Never empty.' })
  reasons!: string[];
}

/**
 * A held change as its seller reads it: the reasons about the seller's own content, and every
 * other reason once as `held-for-review` (Hadi's decision on Hassan S1, PR #1358).
 */
export class OwnOfferChangeViewDto extends OfferChangeBaseDto {
  @ApiProperty({
    enum: SELLER_REVIEW_REASONS,
    isArray: true,
    description:
      'Never empty. certificate-badge, handling and contact-text name what in the change is ' +
      'checked; held-for-review stands for every other reason.',
  })
  reasons!: string[];
}

class OfferChangeOfferDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() sellerSku!: string;
  @ApiProperty() conditionCode!: string;
  @ApiProperty({ description: 'The Offer status now (published while the change waits).' })
  status!: string;
  @ApiProperty({ description: 'The Offer version now (holding the change raised it).' })
  version!: number;
}

class OfferChangeProductDto {
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) typeCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The published name, Market default locale.',
  })
  name!: string | null;
}

class OfferChangeLiveDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The live description (locale to text).',
  })
  description!: Record<string, string>;
  @ApiProperty({ enum: OFFER_HANDLINGS, nullable: true, type: String })
  handling!: string | null;
  @ApiProperty({
    type: [String],
    description: "The type codes of the live Offer's open tags, sorted.",
  })
  tagTypes!: string[];
}

/** A held change as the admin review queue shows it (slice 5): proposed and live values. */
export class OfferChangeListItemDto extends OfferChangeViewDto {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String, description: 'Public store name, if known.' })
  storeName!: string | null;
  @ApiProperty({
    type: OfferChangeOfferDto,
    nullable: true,
    description: 'The Offer as it is now; null only when it cannot be read.',
  })
  offer!: OfferChangeOfferDto | null;
  @ApiProperty({ type: OfferChangeProductDto }) product!: OfferChangeProductDto;
  @ApiProperty({
    type: OfferChangeLiveDto,
    nullable: true,
    description:
      'The live values next to the proposed ones (the Live | Proposed diff); null only when the ' +
      'Offer cannot be read.',
  })
  live!: OfferChangeLiveDto | null;
  @ApiProperty({
    type: [String],
    description: 'The decisions the caller may take: approve, request-changes, reject.',
  })
  actions!: string[];
}

export class OfferChangesListDto {
  @ApiProperty({ type: [OfferChangeListItemDto] }) items!: OfferChangeListItemDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Send as afterId (with limit) for the next page; null on the last page and on a ' +
      'descending read.',
  })
  nextAfterId!: string | null;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ enum: ['pages', 'prev-next'] }) paging!: string;
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'The changes the filters keep over every page; null in prev-next mode.',
  })
  total!: number | null;
  @ApiProperty({ description: 'Every pending change of the Market, whatever the filters.' })
  totalPending!: number;
  @ApiProperty({
    description: 'The store names of q matched more stores than can be searched: narrow it.',
  })
  searchCapped!: boolean;
  @ApiProperty({
    type: [QueueSellerDto],
    description:
      'The stores with a pending change, whatever the filters (the seller filter options): ' +
      'named stores by name, then unnamed ones by id; at most 100.',
  })
  sellers!: QueueSellerDto[];
  @ApiProperty({ description: 'More stores have a pending change than `sellers` holds (100).' })
  sellersCapped!: boolean;
}

/** The active Offer review stops (the admin stop banner). */
export class OfferReviewStopsDto {
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description: "The Market's emergency stop (R0); null when it cannot be read.",
  })
  marketStop!: boolean | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Sellers with their review stop on; null without sellers.seller.view or when unreadable.',
  })
  stoppedSellers!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Platform categories with their review stop on; null when unreadable.',
  })
  stoppedCategories!: number | null;
  @ApiProperty({ description: 'True when any stop that could be read is on.' })
  active!: boolean;
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
