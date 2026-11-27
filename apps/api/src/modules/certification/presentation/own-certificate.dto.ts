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

/** A row of the seller's list and the head of the read (seller pages design 13). */
export class CertificateListItemView extends CertificateSummaryView {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The issuer's public name: the approved submission's, else the newest submission's, else " +
      "the draft's (a draft always shows the draft's).",
  })
  issuerName!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2027-06-30',
    description: 'The last day the approved certificate is valid (a local date); null without one.',
  })
  validUntil!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2027-06-23',
    description:
      "The day to submit a renewal by: validUntil minus the Market's renewalSubmitByDays (as the " +
      'expiry mail). Null without validUntil.',
  })
  renewalSubmitBy!: string | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Whole local days from today to validUntil in the zone the approval was measured in: 0 on ' +
      'the last day, negative once expired.',
  })
  daysLeft!: number | null;
  @ApiProperty({
    nullable: true,
    enum: ['info', 'attention', 'critical'],
    description:
      "The expiry banner's tone from the Market's warning thresholds, for approved-expiring and " +
      'expired only.',
  })
  bannerTone!: string | null;
}

export class CertificateListView {
  @ApiProperty({ type: [CertificateListItemView] }) certificates!: CertificateListItemView[];
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

export class CertificateDecisionView {
  @ApiProperty({ enum: ['changes-requested', 'declined', 'revoked'] }) outcome!: string;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The Market's plain label of the reason; null once the code left the list.",
  })
  reasonLabel!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "A key of the seller's next step (the panel's words).",
  })
  nextStep!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The reviewer's text to the seller, plain text (render inert). Null without one, once the " +
      "seller's key is erased, and always for a revoke.",
  })
  reasonText!: string | null;
  @ApiProperty() decidedAt!: string;
}

export class CertificateHistoryEntryView {
  @ApiProperty({
    enum: [
      'submitted',
      'submitted-again',
      'renewal-submitted',
      'approved',
      'changes-requested',
      'declined',
      'withdrawn',
      'expired',
      'revoked',
    ],
  })
  event!: string;
  @ApiProperty({ nullable: true, type: String }) reasonLabel!: string | null;
  @ApiProperty() at!: string;
}

export class CertificateInForceView {
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) issuerId!: string | null;
  @ApiProperty({ nullable: true, type: String }) issuerName!: string | null;
  @ApiProperty({ nullable: true, type: String }) certificateNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2026-07-01' }) issueDate!: string | null;
  @ApiProperty({ nullable: true, type: String, example: '2027-06-30' }) expiryDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) approvedAt!: string | null;
}

export class CertificateDetailView {
  @ApiProperty({ type: CertificateListItemView }) certificate!: CertificateListItemView;
  @ApiProperty({ type: CertificateDraftView }) draft!: CertificateDraftView;
  @ApiProperty({ type: [CertificateDocumentView] }) documents!: CertificateDocumentView[];
  @ApiProperty({
    nullable: true,
    type: CertificateDecisionView,
    description:
      'The latest decision to act on, for changes-needed, declined, ' +
      'approved-renewal-changes-needed and revoked; null otherwise.',
  })
  decision!: CertificateDecisionView | null;
  @ApiProperty({
    type: [CertificateHistoryEntryView],
    description: 'A short history, newest first (at most 20): never who, never a note.',
  })
  history!: CertificateHistoryEntryView[];
  @ApiProperty({
    nullable: true,
    type: CertificateInForceView,
    description:
      "The approved submission's values (beside a renewal: the certificate in force); null " +
      'without an approval and after a revoke.',
  })
  inForce!: CertificateInForceView | null;
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

export class CertificateDocumentLimitsView {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'], isArray: true })
  mediaTypes!: string[];
  @ApiProperty({ description: 'Bytes of one file.' }) maxBytes!: number;
  @ApiProperty({ description: 'Files on one certificate.' }) maxFiles!: number;
  @ApiProperty({ description: 'Pages of one PDF.' }) maxPdfPages!: number;
  @ApiProperty({ description: 'Bytes of draft files one seller may hold.' })
  draftQuotaBytes!: number;
}

export class CertificateOptionsView {
  @ApiProperty({ type: [CertificateTypeOption] }) types!: CertificateTypeOption[];
  @ApiProperty({ type: CertificateDocumentLimitsView })
  documentLimits!: CertificateDocumentLimitsView;
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

export class ReviewQueueListRowView extends ReviewQueueRowView {
  @ApiProperty({
    enum: ['open', 'decide'],
    isArray: true,
    description: 'The row actions the caller may run (Open always; Decide… with the approve key).',
  })
  actions!: string[];
}

export class ReviewQueueListView {
  @ApiProperty({ type: [ReviewQueueListRowView] }) items!: ReviewQueueListRowView[];
  @ApiProperty({ nullable: true, type: Number, description: 'Null with `paging=prev-next`.' })
  total!: number | null;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ enum: ['pages', 'prev-next'] }) paging!: string;
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({ description: 'The waiting submissions per view, whatever the filter.' })
  counts!: { all: number; initial: number; resubmission: number; renewal: number };
  @ApiProperty({
    description: 'True when more are waiting than the 500 read; the newest are not listed.',
  })
  truncated!: boolean;
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
