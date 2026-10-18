import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Answers and requests of the manufacturer certificate admin routes (certification design 3.4,
// 7.1, 7.2; slice 14). Instants are ISO 8601 strings in UTC; dates are local dates (YYYY-MM-DD);
// ids are UUIDs.

const STATUSES = ['draft', 'in-review', 'approved', 'rejected', 'suspended', 'revoked', 'expired'];

export class ProductCertificateCreateRequest {
  @ApiProperty({
    format: 'uuid',
    description: 'An active third-party document certification type of the Market.',
  })
  typeId!: string;
}

export class CoverageRequestItem {
  @ApiProperty({ format: 'uuid', description: 'A product published in the Market.' })
  productId!: string;
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Null or absent: the whole product. Otherwise 1 to 100 variant ids its published ' +
      'revision has; the certificate then covers only those variants.',
  })
  variantIds?: string[] | null;
}

export class ProductCertificateDraftRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
  @ApiProperty({ nullable: true, description: '1 to 200 characters; null clears it.' })
  manufacturerName!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, description: 'An issuer of the type.' })
  issuerId!: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description: 'Absent keeps the stored number (never read back here); null clears it.',
  })
  certificateNumber?: string | null;
  @ApiProperty({ nullable: true, format: 'date' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, format: 'date' }) expiryDate!: string | null;
  @ApiProperty({
    type: [CoverageRequestItem],
    description:
      'The whole coverage, at most 200 products and 500 entries; each product once. The ' +
      "product's current published revision is recorded by the server, never sent.",
  })
  coverage!: CoverageRequestItem[];
}

export class ProductDecisionRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
  @ApiProperty({ format: 'uuid', description: 'The pending revision that was reviewed.' })
  revisionId!: string;
}

export class ProductRejectRequest extends ProductDecisionRequest {
  @ApiProperty({ description: "A code of the Market's review reasons for a declined outcome." })
  reasonCode!: string;
}

export class ProductSubmitRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
}

class AccountRef {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
}

class CoverageEntryView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid', description: 'The product revision the entry was checked at.' })
  productRevisionId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, description: 'Null: the whole product.' })
  variantId!: string | null;
}

class ProductDocumentView {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ description: 'Its place in the list, from 1.' }) position!: number;
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'] }) mediaType!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ nullable: true, description: 'PDF only.' }) pageCount!: number | null;
  @ApiProperty() createdAt!: string;
}

class ProductCheckView {
  @ApiProperty() checkCode!: string;
  @ApiProperty({ enum: ['done', 'problem', 'not-applicable'] }) result!: string;
  @ApiProperty({ type: AccountRef }) recordedBy!: AccountRef;
  @ApiProperty() recordedAt!: string;
}

class ProductDecisionView {
  @ApiProperty({ enum: ['approved', 'rejected', 'withdrawn'] }) outcome!: string;
  @ApiProperty({ type: AccountRef, nullable: true }) decidedBy!: AccountRef | null;
  @ApiProperty() decidedAt!: string;
  @ApiProperty({ nullable: true }) reasonCode!: string | null;
  @ApiProperty({ nullable: true }) expiryBoundaryAt!: string | null;
  @ApiProperty({ nullable: true, description: 'The Market zone that measured the expiry.' })
  boundaryZone!: string | null;
}

class ProductRevisionView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ format: 'uuid', description: 'The type revision in force at submission.' })
  typeRevisionId!: string;
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty() manufacturerName!: string;
  @ApiProperty({ nullable: true, format: 'date' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, format: 'date' }) expiryDate!: string | null;
  @ApiProperty({ type: AccountRef }) submittedBy!: AccountRef;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ type: [AccountRef], description: 'Who edited the draft, and the submitter.' })
  editors!: AccountRef[];
  @ApiProperty({ type: [CoverageEntryView] }) coverage!: CoverageEntryView[];
  @ApiProperty({ type: [ProductDocumentView], description: 'Sealed at submission.' })
  documents!: ProductDocumentView[];
  @ApiProperty({ type: [ProductCheckView], description: 'The latest result per check code.' })
  checks!: ProductCheckView[];
  @ApiProperty({ type: ProductDecisionView, nullable: true }) decision!: ProductDecisionView | null;
  @ApiPropertyOptional({ description: 'Only on the review read.' }) certificateNumber?: string;
}

class ProductDraftView {
  @ApiProperty({ nullable: true }) manufacturerName!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) issuerId!: string | null;
  @ApiProperty() certificateNumberSet!: boolean;
  @ApiProperty({ nullable: true, format: 'date' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, format: 'date' }) expiryDate!: string | null;
  @ApiProperty({ type: [CoverageEntryView] }) coverage!: CoverageEntryView[];
  @ApiProperty({ type: [AccountRef] }) editors!: AccountRef[];
  @ApiProperty({ type: [ProductDocumentView] }) documents!: ProductDocumentView[];
  @ApiPropertyOptional({ nullable: true, description: 'Only on the review read.' })
  certificateNumber?: string | null;
}

class ReviewCheckListItem {
  @ApiProperty() checkCode!: string;
  @ApiProperty() required!: boolean;
}

export class ProductCertificateView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: AccountRef }) author!: AccountRef;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty({ nullable: true }) approvedBoundaryAt!: string | null;
  @ApiProperty({ type: ProductDraftView }) draft!: ProductDraftView;
  @ApiProperty({ type: ProductRevisionView, nullable: true }) pending!: ProductRevisionView | null;
  @ApiProperty({ type: ProductRevisionView, nullable: true }) approved!: ProductRevisionView | null;
}

class ProductCertificateListItemView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ nullable: true }) manufacturerName!: string | null;
  @ApiProperty({ description: "The draft's coverage entries." }) coverageEntries!: number;
  @ApiProperty({ format: 'uuid', nullable: true }) pendingRevisionId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) approvedRevisionId!: string | null;
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() version!: number;
}

export class ProductCertificateListView {
  @ApiProperty({ type: [ProductCertificateListItemView] }) items!: ProductCertificateListItemView[];
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}

export class ProductCertificateCreatedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ enum: ['draft'] }) status!: string;
  @ApiProperty() version!: number;
}

export class ProductDraftSavedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() coverageEntries!: number;
}

export class ProductSubmittedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty() version!: number;
}

export class ProductDecidedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty({ enum: ['approved', 'rejected'] }) outcome!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() decidedAt!: string;
}

export class ProductEndRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
  @ApiProperty({
    description:
      "A code of the Market's review reasons listed for the action's outcome (suspended or " +
      'revoked).',
  })
  reasonCode!: string;
  @ApiPropertyOptional({
    nullable: true,
    description: 'An optional note, at most 1000 characters; sealed, never read back here.',
  })
  reasonText?: string | null;
}

export class ProductEndedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ enum: ['suspended', 'revoked'] }) status!: string;
  @ApiProperty({ format: 'uuid', description: 'The approved revision the record holds.' })
  revisionId!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'The pending revision a revocation withdrew, if any.',
  })
  withdrawnRevisionId!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty() changedAt!: string;
}

export class ProductReinstateRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
}

export class ProductReinstatedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ enum: ['approved'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() version!: number;
  @ApiProperty() reinstatedAt!: string;
}

class ProductHistoryEntryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: STATUSES, nullable: true }) fromStatus!: string | null;
  @ApiProperty({ enum: STATUSES }) toStatus!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) revisionId!: string | null;
  @ApiProperty({ type: AccountRef, nullable: true, description: 'Null: the system (the job).' })
  actor!: AccountRef | null;
  @ApiProperty({ nullable: true }) reasonCode!: string | null;
  @ApiProperty({ description: 'A note was given; its text is never shown here.' })
  noteGiven!: boolean;
  @ApiProperty() occurredAt!: string;
}

export class ProductHistoryView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ type: [ProductHistoryEntryView], description: 'Newest first, at most 200.' })
  entries!: ProductHistoryEntryView[];
}

export class ProductCertificateReviewView extends ProductCertificateView {
  @ApiProperty({
    type: [ReviewCheckListItem],
    description: "The Market's checks for a third-party document type.",
  })
  reviewChecks!: ReviewCheckListItem[];
}

export class ProductDocumentUploadRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
  @ApiProperty({
    description: 'The file as standard base64 text, at most 10 MiB decoded (JPEG, PNG or PDF).',
  })
  data!: string;
}

export class ProductDocumentUploadedView extends ProductDocumentView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ description: 'The new record version.' }) version!: number;
}

export class ProductDocumentRemovedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty({ description: 'False: a revision holds the file, so it only left the draft.' })
  deleted!: boolean;
  @ApiProperty({ description: 'The new record version.' }) version!: number;
}

export class ProductCheckRequest {
  @ApiProperty({ description: 'The record version as it was read.' }) version!: number;
  @ApiProperty({ format: 'uuid', description: 'The pending revision being checked.' })
  revisionId!: string;
  @ApiProperty({ description: "A code of the Market's review checks." }) checkCode!: string;
  @ApiProperty({ enum: ['done', 'problem', 'not-applicable'] }) result!: string;
}

export class ProductCheckRecordedView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty({ format: 'uuid' }) checkId!: string;
  @ApiProperty() checkCode!: string;
  @ApiProperty({ enum: ['done', 'problem', 'not-applicable'] }) result!: string;
  @ApiProperty() recordedAt!: string;
  @ApiProperty({ description: 'The new record version.' }) version!: number;
}
