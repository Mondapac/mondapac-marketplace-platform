import { ApiProperty } from '@nestjs/swagger';

// Answers and requests of the seller certificate routes (certification design 7.2). Ids, codes
// and the seller's own content only; instants are ISO 8601 strings in UTC, dates are local dates.

export class CertificationErrorBody {
  @ApiProperty() statusCode!: number;
  @ApiProperty({ description: 'A stable machine-readable code, such as certificate.not-found.' })
  code!: string;
  @ApiProperty({ required: false, type: Object })
  details?: Record<string, unknown>;
}

export class CertificateCreateRequest {
  @ApiProperty({ description: 'The code of an active certification type of the Market.' })
  typeCode!: string;
}

export class CertificateSummaryView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({
    description: 'The seller-visible status code (design 3.3).',
    enum: [
      'draft',
      'draft-issuer-not-listed',
      'awaiting-review',
      'changes-needed',
      'declined',
      'approved',
      'approved-expiring',
      'approved-renewal-pending',
      'approved-renewal-changes-needed',
      'expired',
      'expired-renewal-pending',
      'revoked',
      'issuer-not-recognised',
    ],
  })
  status!: string;
  @ApiProperty({ description: 'The status of the record itself.' }) recordStatus!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'For approved-expiring and approved-renewal-changes-needed: the instant the approved ' +
      'certificate stops counting.',
  })
  submitBy!: string | null;
  @ApiProperty() editable!: boolean;
  @ApiProperty() deletable!: boolean;
  @ApiProperty() withdrawable!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastChangedAt!: string;
}

export class CertificateListView {
  @ApiProperty({ type: [CertificateSummaryView] }) certificates!: CertificateSummaryView[];
  @ApiProperty({ nullable: true, type: String }) nextAfterId!: string | null;
}

export class CertificateDraftView {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String }) certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-06-30' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2028-06-30' }) expiryDate!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) selfDeclared!: boolean | null;
  @ApiProperty({ nullable: true, type: String }) selfDeclarationNote!: string | null;
}

export class CertificateDocumentView {
  @ApiProperty({ format: 'uuid' }) documentId!: string;
  @ApiProperty() position!: number;
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'] }) mediaType!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ nullable: true, type: Number }) pageCount!: number | null;
  @ApiProperty() createdAt!: string;
}

export class CertificateDocumentUploaded extends CertificateDocumentView {
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The pending submission this change withdrew (cause edited), or null.',
  })
  withdrawnSubmissionId!: string | null;
}

export class CertificateDetailView {
  @ApiProperty({ type: CertificateSummaryView }) certificate!: CertificateSummaryView;
  @ApiProperty({ type: CertificateDraftView }) draft!: CertificateDraftView;
  @ApiProperty({ type: [CertificateDocumentView] }) documents!: CertificateDocumentView[];
}

export class CertificateDraftSaved {
  @ApiProperty({ type: CertificateSummaryView }) certificate!: CertificateSummaryView;
  @ApiProperty({ type: CertificateDraftView }) draft!: CertificateDraftView;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The pending submission this change withdrew (cause edited), or null.',
  })
  withdrawnSubmissionId!: string | null;
}

export class CertificateDraftRequest {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'At most 64 characters.' })
  certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-06-30' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2028-06-30' }) expiryDate!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) selfDeclared!: boolean | null;
  @ApiProperty({ nullable: true, type: String, description: 'At most 1000 characters.' })
  selfDeclarationNote!: string | null;
}

export class CertificateSubmitted {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ enum: ['initial', 'resubmission', 'renewal'] }) kind!: string;
  @ApiProperty() submittedAt!: string;
}

export class CertificateDocumentUploadRequest {
  @ApiProperty({
    description:
      'The file as standard base64 text: JPEG, PNG or PDF, at most 10 MiB of bytes. The type is ' +
      'read from the content.',
  })
  data!: string;
}

export class CertificateIssuerOption {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty() displayName!: string;
}

export class CertificateTypeOption {
  @ApiProperty() code!: string;
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
  @ApiProperty({ enum: ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'] }) verificationMode!: string;
  @ApiProperty() requiresIssuerRegistry!: boolean;
  @ApiProperty() requiresDocument!: boolean;
  @ApiProperty() requiresExpiry!: boolean;
  @ApiProperty({ type: [CertificateIssuerOption] }) issuers!: CertificateIssuerOption[];
}

export class CertificateOptionsView {
  @ApiProperty({ type: [CertificateTypeOption] }) types!: CertificateTypeOption[];
}

export class CertificateDeleted {
  @ApiProperty() deleted!: true;
}

export class CertificateDocumentRemoved {
  @ApiProperty() removed!: true;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The pending submission this change withdrew (cause edited), or null.',
  })
  withdrawnSubmissionId!: string | null;
}

// Answers and requests of the admin review routes (certification design 7.2; slice 7). The
// review page holds personal data (certificate number, business details) and is `no-store`.

export class ReviewQueueRowView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ description: 'The version a decision must name.' }) version!: number;
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty() submissionNo!: number;
  @ApiProperty({ enum: ['initial', 'resubmission', 'renewal'] }) kind!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuerName!: string | null;
  @ApiProperty() submittedAt!: string;
}

export class ReviewQueueView {
  @ApiProperty({ type: [ReviewQueueRowView] }) items!: ReviewQueueRowView[];
  @ApiProperty({ nullable: true, type: String }) nextAfterId!: string | null;
  @ApiProperty() total!: number;
}

export class ReviewOtherDecisionView {
  @ApiProperty({ enum: ['approved', 'changes-requested', 'declined', 'withdrawn'] })
  outcome!: string;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) reasonText!: string | null;
  @ApiProperty({ nullable: true, enum: ['edited', 'cancelled', 'revoked'], type: String })
  withdrawCause!: string | null;
  @ApiProperty() decidedAt!: string;
}

export class ReviewOtherSubmissionView {
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty() submissionNo!: number;
  @ApiProperty({ enum: ['initial', 'resubmission', 'renewal'] }) kind!: string;
  @ApiProperty({
    enum: ['pending', 'approved', 'superseded', 'changes-requested', 'declined', 'withdrawn'],
  })
  status!: string;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ nullable: true, type: String }) issuerName!: string | null;
  @ApiProperty({ nullable: true, type: String }) certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) expiryDate!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'For an approval: the instant it stops counting.',
  })
  validUntil!: string | null;
  @ApiProperty({ type: ReviewOtherDecisionView, nullable: true })
  decision!: ReviewOtherDecisionView | null;
}

export class ReviewPageView {
  @ApiProperty({ type: Object }) certificate!: Record<string, unknown>;
  @ApiProperty({ type: Object }) submission!: Record<string, unknown>;
  @ApiProperty({ type: [Object] }) documents!: Record<string, unknown>[];
  @ApiProperty({ type: [Object], description: 'Every check of the Market with its latest result.' })
  checks!: Record<string, unknown>[];
  @ApiProperty({ type: Object, nullable: true }) scope!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, nullable: true }) confirmation!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, description: 'The reasons by outcome, with their next steps.' })
  reasons!: Record<string, unknown>;
  @ApiProperty({ type: [Object], description: 'Same number or same file at another seller.' })
  duplicateHints!: Record<string, unknown>[];
  @ApiProperty({ type: Object }) business!: Record<string, unknown>;
  @ApiProperty({ type: [Object] }) history!: Record<string, unknown>[];
  @ApiProperty({ type: Object, nullable: true }) decision!: Record<string, unknown> | null;
  @ApiProperty({
    type: [ReviewOtherSubmissionView],
    description:
      'The other submissions of the record, newest first (at most 10, plus the approved one): ' +
      'the earlier submission and its reason, and beside a renewal the certificate in force.',
  })
  otherSubmissions!: ReviewOtherSubmissionView[];
}

export class ReviewCheckRequest {
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ description: 'A check code of the Market policy.' }) checkCode!: string;
  @ApiProperty({ enum: ['done', 'problem', 'not-applicable'] }) result!: string;
}

export class ReviewCheckRecorded {
  @ApiProperty({ format: 'uuid' }) checkId!: string;
  @ApiProperty() checkCode!: string;
  @ApiProperty() result!: string;
  @ApiProperty() recordedAt!: string;
}

export class ReviewScopeRequest {
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ description: 'The location the certificate covers, as read.' }) location!: string;
  @ApiProperty({ description: 'The product or activity scope, as read.' }) scope!: string;
}

export class ReviewScopeRecorded {
  @ApiProperty() recordedAt!: string;
}

export class ReviewConfirmationRequest {
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ format: 'uuid', description: 'A contact channel of the submission issuer.' })
  channelId!: string;
  @ApiProperty({ example: '2027-06-30' }) confirmedOn!: string;
  @ApiProperty({ description: 'The issuer reference of the confirmation (stored encrypted).' })
  reference!: string;
  @ApiProperty() confirmsNumber!: boolean;
  @ApiProperty() confirmsHolder!: boolean;
}

export class ReviewConfirmationRecorded {
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ description: 'The record version after the change.' }) version!: number;
  @ApiProperty() recordedAt!: string;
}

export class ReviewApproveRequest {
  @ApiProperty({ format: 'uuid', description: 'The submission the reviewer saw.' })
  submissionId!: string;
  @ApiProperty({ description: 'The record version the reviewer saw.' }) version!: number;
}

export class ReviewNegativeDecisionRequest extends ReviewApproveRequest {
  @ApiProperty({ description: 'A reason code of the Market policy.' }) reasonCode!: string;
  @ApiProperty({ required: false, nullable: true, type: String }) reasonText?: string | null;
}

export class ReviewDecided {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) submissionId!: string;
  @ApiProperty({ enum: ['approved', 'changes-requested', 'declined'] }) outcome!: string;
  @ApiProperty() status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() decidedAt!: string;
}

export class RevokeRequest {
  @ApiProperty({ description: 'The record version the admin saw.' }) version!: number;
  @ApiProperty({ description: "A reason code of the Market policy listed for 'revoked'." })
  reasonCode!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'An optional note (at most 1000 characters), kept encrypted on the history row.',
  })
  reasonText?: string | null;
}

export class RevokeDone {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ enum: ['revoked'] }) status!: string;
  @ApiProperty({ format: 'uuid', description: 'The approved submission the record held.' })
  submissionId!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The pending submission withdrawn with the revoke (cause revoked), if any.',
  })
  withdrawnSubmissionId!: string | null;
  @ApiProperty({ description: 'The record version after the revoke.' }) version!: number;
  @ApiProperty() revokedAt!: string;
}

export class HistoryEntryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) fromStatus!: string | null;
  @ApiProperty() toStatus!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) submissionId!: string | null;
  @ApiProperty({ enum: ['seller', 'admin', 'system'] }) actorKind!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) actorAccountId!: string | null;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "The Market's label of the code." })
  reasonLabel!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The decrypted note, if any.' })
  note!: string | null;
  @ApiProperty() occurredAt!: string;
}

export class HistoryView {
  @ApiProperty({ format: 'uuid' }) certificateId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ type: [HistoryEntryView], description: 'Newest first.' })
  entries!: HistoryEntryView[];
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Pass as beforeId for the next (older) page; null on the last page.',
  })
  nextBeforeId!: string | null;
}
