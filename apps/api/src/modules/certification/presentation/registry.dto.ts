import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Answers and requests of the type and issuer registry admin routes (certification design 3.5,
// 3.6, 7.1, 7.2, 7.6; slice 12). Instants are ISO 8601 strings in UTC; ids are UUIDs.

const PROPOSAL_STATES = ['pending', 'approved', 'rejected', 'withdrawn', 'superseded'];
const PROPOSAL_SUBJECTS = ['type-revision', 'type-reactivation', 'issuer-reactivation'];
const ISSUER_STATES = ['proposed', 'active', 'closed-to-new', 'derecognised'];

export class VersionRequest {
  @ApiProperty({ description: 'The version of the row as it was read.' }) version!: number;
}

export class ReasonedVersionRequest extends VersionRequest {
  @ApiPropertyOptional({
    description: 'Optional change reason, at most 500 characters; stored only encrypted.',
  })
  reason?: string;
}

export class ExpertApprovalRequest {
  @ApiProperty({ description: 'Who confirmed the issuer, 1 to 120 characters.' })
  confirmedBy!: string;
  @ApiProperty({ description: 'A document or note reference, 1 to 300 characters.' })
  reference!: string;
}

class AllowedView {
  @ApiProperty() allowed!: boolean;
  @ApiPropertyOptional({ description: 'The denial code when not allowed.' }) code?: string;
}

class ProposalActionsView {
  @ApiProperty({ type: AllowedView }) approve!: AllowedView;
  @ApiProperty({ type: AllowedView }) reject!: AllowedView;
  @ApiProperty({ type: AllowedView }) withdraw!: AllowedView;
}

class AccountRefView {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
}

class ChangeReasonView {
  @ApiProperty({ enum: ['given', 'erased'] }) state!: string;
  @ApiPropertyOptional({ description: 'Admin text, shown as plain text.' }) text?: string;
}

class DiffEntryView {
  @ApiProperty({ description: 'A setting key, or locales/names/descriptions/terms.<locale>.' })
  path!: string;
  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'boolean' }] })
  before!: string | boolean | null;
  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'boolean' }] })
  after!: string | boolean | null;
  @ApiProperty({ description: 'Why a second admin is needed.' }) relaxes!: boolean;
}

export class RelaxationProposalView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PROPOSAL_SUBJECTS }) subject!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty({ nullable: true, type: String }) basedOnRevisionId!: string | null;
  @ApiProperty({ nullable: true, type: String }) proposedRevisionId!: string | null;
  @ApiProperty({ type: AccountRefView }) proposer!: AccountRefView;
  @ApiProperty() proposedAt!: string;
  @ApiProperty({ type: ChangeReasonView, nullable: true }) reason!: ChangeReasonView | null;
  @ApiProperty({ type: [DiffEntryView] }) diff!: DiffEntryView[];
  @ApiProperty({ enum: PROPOSAL_STATES }) state!: string;
  @ApiProperty({ type: AccountRefView, nullable: true }) decidedBy!: AccountRefView | null;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ type: ProposalActionsView }) actions!: ProposalActionsView;
}

const CONTENT_SCHEMA = {
  type: 'object',
  description:
    'verificationMode (fixed for the type), requiresIssuerRegistry, requiresDocument, ' +
    'requiresExpiry, defaultBasis, autoApproveSelfDeclaration, badgeIconKey, and locales: one ' +
    'entry per supported locale of the Market with name, customerDescription and claimTerms.',
  additionalProperties: true,
} as const;

class TypeListRowView {
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty() verificationMode!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'uuid' }) publishedRevisionId!: string;
  @ApiProperty() publishedRevisionNo!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
  @ApiProperty({ enum: PROPOSAL_SUBJECTS, isArray: true }) pending!: string[];
}

export class TypesListView {
  @ApiProperty({ type: [TypeListRowView] }) items!: TypeListRowView[];
}

class PublishedRevisionView {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty(CONTENT_SCHEMA) content!: Record<string, unknown>;
  @ApiProperty({ format: 'uuid' }) authorAccountId!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: ChangeReasonView, nullable: true }) reason!: ChangeReasonView | null;
}

export class TypeView {
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: PublishedRevisionView }) published!: PublishedRevisionView;
  @ApiProperty({ type: RelaxationProposalView, nullable: true })
  pendingRevision!: RelaxationProposalView | null;
  @ApiProperty({ type: RelaxationProposalView, nullable: true })
  pendingReactivation!: RelaxationProposalView | null;
}

export class TypeRevisionRequest extends ReasonedVersionRequest {
  @ApiProperty(CONTENT_SCHEMA) content!: Record<string, unknown>;
}

export class TypeRevisionSavedView {
  @ApiProperty({ enum: ['published', 'pending-second-admin'] }) outcome!: string;
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'The type version; unchanged while pending.' }) version!: number;
  @ApiPropertyOptional({ description: 'Published only.' }) claimTermsChanged?: boolean;
  @ApiPropertyOptional({ format: 'uuid', description: 'Pending only.' }) proposalId?: string;
  @ApiPropertyOptional({ type: [String], description: 'Pending only: what relaxes.' })
  relaxations?: string[];
}

export class TypeStatusView {
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiPropertyOptional() version?: number;
  @ApiPropertyOptional({ format: 'uuid' }) proposalId?: string;
  @ApiPropertyOptional() typeVersion?: number;
}

export class TypeRelaxationApprovedView {
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ format: 'uuid' }) proposalId!: string;
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty({ enum: ['approved'] }) state!: string;
  @ApiProperty() typeVersion!: number;
}

export class ProposalClosedView {
  @ApiProperty({ format: 'uuid' }) proposalId!: string;
  @ApiProperty({ enum: ['rejected', 'withdrawn'] }) state!: string;
  @ApiProperty() version!: number;
}

export class IssuerSummaryView {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true, type: String }) accreditationNumber!: string | null;
  @ApiProperty({ enum: ISSUER_STATES }) state!: string;
  @ApiProperty() version!: number;
  @ApiProperty() stateChangedAt!: string;
}

export class IssuersListView {
  @ApiProperty({ type: [IssuerSummaryView] }) items!: IssuerSummaryView[];
  @ApiProperty({ nullable: true, type: String }) nextAfterId!: string | null;
}

export class IssuerView extends IssuerSummaryView {
  @ApiProperty({ enum: ['admin', 'seed'] }) stateChangedByKind!: string;
  @ApiProperty({ nullable: true, type: String }) stateChangedByAccountId!: string | null;
  @ApiProperty() expertReferenceRecorded!: boolean;
  @ApiProperty({ description: 'Approved certificates naming this issuer now.' })
  affectedCertificates!: number;
  @ApiProperty({ type: RelaxationProposalView, nullable: true })
  pendingReactivation!: RelaxationProposalView | null;
  @ApiProperty() createdAt!: string;
}

class ExpertApprovalView {
  @ApiProperty() confirmedBy!: string;
  @ApiProperty() reference!: string;
}

class PendingExpertApprovalView {
  @ApiProperty({ format: 'uuid' }) proposalId!: string;
  @ApiProperty({ type: ExpertApprovalView }) expertApproval!: ExpertApprovalView;
}

export class IssuerExpertReferenceView {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty({ type: ExpertApprovalView, nullable: true }) current!: ExpertApprovalView | null;
  @ApiProperty({ type: PendingExpertApprovalView, nullable: true })
  pendingReactivation!: PendingExpertApprovalView | null;
}

export class IssuerCreateRequest {
  @ApiProperty({ format: 'uuid' }) typeId!: string;
  @ApiProperty({ description: 'The public name (it appears on the badge), 1 to 200 characters.' })
  displayName!: string;
  @ApiPropertyOptional({
    description: 'The official accreditation number, if any, at most 64 characters.',
  })
  accreditationNumber?: string;
}

export class IssuerActivateRequest extends VersionRequest {
  @ApiProperty({ type: ExpertApprovalRequest }) expertApproval!: ExpertApprovalRequest;
}

export class IssuerReactivationRequest extends ReasonedVersionRequest {
  @ApiProperty({ type: ExpertApprovalRequest, description: 'A reference other than the current.' })
  expertApproval!: ExpertApprovalRequest;
}

export class IssuerDerecogniseRequest extends VersionRequest {
  @ApiProperty({ description: 'The affected certificate count the form showed, confirmed.' })
  affectedCertificates!: number;
}

export class IssuerStateView {
  @ApiProperty({ format: 'uuid' }) issuerId!: string;
  @ApiProperty({ enum: ISSUER_STATES }) state!: string;
  @ApiPropertyOptional() version?: number;
  @ApiPropertyOptional({ format: 'uuid' }) typeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) proposalId?: string;
  @ApiPropertyOptional() issuerVersion?: number;
  @ApiPropertyOptional() affectedCertificates?: number;
}
