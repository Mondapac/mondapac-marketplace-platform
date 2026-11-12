import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the seller category proposal and shelf routes (categories C9a). Ids,
// codes and the names a seller typed; never an account id or a permission.

const TEXTS_DESCRIPTION =
  'Keyed by locale: `{ "<locale>": { "name": "…", "shortDescription": "…" } }`. The Market default ' +
  'locale needs a name; other supported locales are optional. No keywords.';

export class ShelfTextBody {
  @ApiProperty() locale!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
}

export class ProposalBodyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ format: 'uuid' }) platformParentId!: string;
  @ApiProperty({ type: [ShelfTextBody] }) texts!: ShelfTextBody[];
  @ApiProperty({ enum: ['pending', 'approved', 'rejected', 'cancelled'] }) status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'A rejection reason (already-exists, too-narrow, too-broad, misleading, not-sold-here, ' +
      'other) or a cancellation reason (seller-cancelled, permission-revoked).',
  })
  reasonCode!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) sellerCategoryId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ShelfBodyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) platformParentId!: string;
  @ApiProperty({ description: 'Unique among the seller’s shelves.' }) slug!: string;
  @ApiProperty({ enum: ['active', 'promoted', 'merged', 'archived'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) mergedIntoId!: string | null;
  @ApiProperty({ type: [ShelfTextBody] }) texts!: ShelfTextBody[];
  @ApiProperty() version!: number;
}

export class CategoryProposeRequest {
  @ApiProperty({ format: 'uuid', description: 'A live platform category.' })
  platformParentId!: string;
  @ApiProperty({ type: Object, description: TEXTS_DESCRIPTION }) texts!: Record<string, unknown>;
}

export class CategoryProposedBody {
  @ApiProperty({ format: 'uuid' }) proposalId!: string;
  @ApiProperty({ enum: ['pending'] }) status!: 'pending';
}

export class OwnCategoryProposalsBody {
  @ApiProperty({ description: 'Whether the seller may propose now (SEL-26).' })
  canPropose!: boolean;
  @ApiProperty({ description: 'The most proposals that may wait at once.' }) maxPending!: number;
  @ApiProperty({ type: [ProposalBodyDto] }) proposals!: ProposalBodyDto[];
  @ApiProperty({ type: [ShelfBodyDto] }) shelves!: ShelfBodyDto[];
}

export class ProposalVersionRequest {
  @ApiProperty({ description: 'The proposal version the page read.' }) version!: number;
}

export class ProposalRejectRequest {
  @ApiProperty({ description: 'The proposal version the page read.' }) version!: number;
  @ApiProperty({
    enum: ['already-exists', 'too-narrow', 'too-broad', 'misleading', 'not-sold-here', 'other'],
  })
  reasonCode!: string;
}

export class ProposalDecidedBody {
  @ApiProperty({ enum: ['approved', 'rejected', 'cancelled'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ required: false, format: 'uuid' }) sellerCategoryId?: string;
  @ApiProperty({ required: false }) slug?: string;
}

export class ProposalQueueItemBody extends ProposalBodyDto {
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
}

export class ProposalQueueBody {
  @ApiProperty({ type: [ProposalQueueItemBody] }) items!: ProposalQueueItemBody[];
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) nextAfterId!: string | null;
}

export class ShelfListBody {
  @ApiProperty({ type: [ShelfBodyDto] }) shelves!: ShelfBodyDto[];
}

export class ShelfPromoteRequest {
  @ApiProperty({ description: 'The shelf version the page read.' }) version!: number;
  @ApiProperty({ description: 'A free platform slug, English: lower-case words and hyphens.' })
  slug!: string;
  @ApiProperty({ description: 'The tree version the page read.' }) treeVersion!: number;
}

export class ShelfPromotedBody {
  @ApiProperty({ format: 'uuid', description: 'The shelf’s own id.' }) categoryId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['hidden'] }) status!: 'hidden';
  @ApiProperty() treeVersion!: number;
  @ApiProperty() offersCleared!: number;
}

export class ShelfMergeRequest {
  @ApiProperty({ description: 'The shelf version the page read.' }) version!: number;
  @ApiProperty({ format: 'uuid', description: 'A live platform category.' }) categoryId!: string;
}

export class ShelfMergedBody {
  @ApiProperty({ enum: ['merged'] }) status!: 'merged';
  @ApiProperty({ format: 'uuid' }) mergedIntoId!: string;
  @ApiProperty() offersCleared!: number;
}

export class OfferShelfRequest {
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'null clears it.' })
  shelfId!: string | null;
  @ApiProperty({ description: 'The Offer version the page read.' }) version!: number;
}

export class OfferShelfBody {
  @ApiProperty() version!: number;
}
