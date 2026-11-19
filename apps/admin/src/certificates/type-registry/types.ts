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

export interface TypeRow {
  readonly typeId: string;
  readonly code: string;
  readonly status: 'active' | 'inactive';
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
  readonly status: 'active' | 'inactive';
  readonly version: number;
  readonly published: {
    readonly revisionNo: number;
    readonly createdAt: string;
    readonly content: TypeContent;
  };
  readonly pendingRevision: TypeProposal | null;
  readonly pendingReactivation: TypeProposal | null;
}

export interface TypeRevisionSaved {
  readonly outcome: 'published' | 'pending-second-admin';
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
