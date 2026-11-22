// Answers of GET certification/admin/types (apps/api certification registry.dto.ts).

export const TYPE_VIEW_PERMISSION = 'certification.type.view';
export const TYPE_EDIT_PERMISSION = 'certification.type.edit';
export const API_TYPES = 'certification/admin/types';
export const API_POLICIES = 'certification/admin/claim-policies';
export const POLICY_VIEW_PERMISSION = 'certification.claim-policy.view';
export const POLICY_EDIT_PERMISSION = 'certification.claim-policy.edit';
export const REASON_MAX = 500;

export const PROPOSAL_KINDS = ['revision', 'reactivation', 'policy'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const TYPE_STATUSES = ['proposed', 'active', 'inactive', 'rejected', 'withdrawn'] as const;
export type TypeStatus = (typeof TYPE_STATUSES)[number];
export const STATUS_TONE: Readonly<
  Record<TypeStatus, 'info' | 'success' | 'attention' | 'critical' | 'neutral'>
> = {
  proposed: 'info',
  active: 'success',
  inactive: 'attention',
  rejected: 'critical',
  withdrawn: 'neutral',
};
export const API_ISSUERS = 'certification/admin/issuers';
export const API_IMPACT_COUNT = 'catalog/admin/claim-terms/impact-count';
export const API_NEW_OPTIONS = `${API_TYPES}/new-options`;
export const VERIFICATION_MODES = ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export interface TypeRow {
  readonly typeId: string;
  readonly code: string;
  readonly status: TypeStatus;
  readonly verificationMode: string;
  readonly version: number;
  readonly publishedRevisionNo: number;
  /** Display names by locale. */
  readonly names: Readonly<Record<string, string>>;
  /** Which kinds of proposal wait for a second admin. */
  readonly pending: readonly string[];
}

export interface TypeList {
  readonly items: readonly TypeRow[];
}

export interface ProposalAction {
  readonly allowed: boolean;
  readonly code?: string;
}

export interface DiffEntry {
  readonly path: string;
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
  /** True when the change needs a second admin. */
  readonly relaxes: boolean;
}

export interface TypeProposal {
  readonly id: string;
  /** Who proposed it; absent in older answers. */
  readonly proposer?: { readonly accountId: string };
  readonly proposedAt: string;
  readonly state: string;
  readonly version: number;
  readonly reason?: { readonly state: string; readonly text?: string } | null;
  readonly diff: readonly DiffEntry[];
  readonly actions: {
    readonly approve: ProposalAction;
    readonly reject: ProposalAction;
    readonly withdraw: ProposalAction;
  };
}

export interface LocaleContent {
  readonly name?: string;
  readonly customerDescription?: string;
  readonly claimTerms?: readonly string[];
}

export interface TypeContent {
  readonly verificationMode?: string;
  readonly requiresIssuerRegistry?: boolean;
  readonly requiresDocument?: boolean;
  readonly requiresExpiry?: boolean;
  readonly defaultBasis?: string;
  readonly autoApproveSelfDeclaration?: boolean;
  readonly badgeIconKey?: string;
  readonly locales?: Readonly<Record<string, LocaleContent>>;
}

export interface TypeDetail {
  readonly typeId: string;
  readonly code: string;
  readonly status: TypeStatus;
  readonly version: number;
  readonly published: {
    readonly revisionNo: number;
    readonly createdAt: string;
    readonly content: TypeContent;
  };
  readonly pendingRevision: TypeProposal | null;
  readonly pendingReactivation: TypeProposal | null;
  /** A proposed new type waiting for a second admin (FE-091). */
  readonly pendingCreation?: TypeProposal | null;
}

/** Answer of GET certification/admin/types/new-options. */
export interface TypeNewOptions {
  readonly locales: readonly string[];
  readonly verificationModes: readonly string[];
  readonly defaultBases: readonly string[];
  readonly badgeArtworkKeys: readonly string[];
  readonly limits: {
    readonly codeMinLength: number;
    readonly codeMaxLength: number;
    readonly nameMaxLength: number;
    readonly descriptionMaxLength: number;
    readonly claimTermsPerLocale: number;
    readonly claimTermMaxLength: number;
    readonly reasonMaxLength: number;
  };
}

export interface TypeCreated {
  readonly typeId: string;
  readonly proposalId: string;
  readonly status: 'proposed';
  readonly proposalVersion: number;
}

/** Answer of POST catalog/admin/claim-terms/impact-count. */
export interface ImpactCount {
  readonly products: number;
  readonly offers: number;
  readonly total: number;
  /** False when the scan stopped early: the numbers are "at least". */
  readonly complete: boolean;
}

export interface TypeRevisionSaved {
  readonly outcome: 'published' | 'pending-second-admin' | 'proposal-revised';
  readonly typeId: string;
  readonly revisionNo: number;
}

export const POLICY_BASES = [
  'SELLER_REQUIRED',
  'SELLER_OR_MANUFACTURER',
  'NOT_APPLICABLE',
] as const;
export const POLICY_HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;

/** One row of a claim basis policy: for a platform category or for a handling type. */
export interface PolicyRow {
  readonly selector: 'platform-category' | 'handling';
  readonly categoryId?: string;
  readonly handling?: string;
  readonly basis: string;
}

export interface PolicyHistoryEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly createdAt: string;
  readonly reasonGiven: boolean;
  readonly published: boolean;
}

/** Answer of GET certification/admin/claim-policies/:typeId. */
export interface PolicyDetail {
  readonly typeId: string;
  readonly typeCode: string;
  readonly defaultBasis: string;
  readonly version: number;
  readonly published: {
    readonly revisionNo: number;
    readonly createdAt: string;
    readonly rows: readonly PolicyRow[];
    readonly reason?: { readonly state: string; readonly text?: string } | null;
  } | null;
  readonly pendingRevision: {
    readonly proposal: TypeProposal;
    readonly rows: readonly PolicyRow[];
  } | null;
  readonly history: readonly PolicyHistoryEntry[];
  readonly review: { readonly reviewed: boolean; readonly risk: string };
}

export interface PolicySaved {
  readonly outcome: 'published' | 'pending-second-admin';
  readonly typeId: string;
  readonly request: { readonly id: string; readonly number: number } | null;
}

/** The public category tree (GET catalog/categories), depth first. */
export interface PolicyCategories {
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly depth: number;
  }[];
}
