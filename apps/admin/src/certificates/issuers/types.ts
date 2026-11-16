// Answers of GET certification/admin/issuers (apps/api certification registry.dto.ts).

export const ISSUER_VIEW_PERMISSION = 'certification.issuer.view';
export const ISSUER_EDIT_PERMISSION = 'certification.issuer.edit';
export const API_ISSUERS = 'certification/admin/issuers';
export const PAGE_SIZE = 25;
export const NAME_MAX = 200;
export const ACCREDITATION_MAX = 64;
export const CONFIRMED_BY_MAX = 120;
export const REFERENCE_MAX = 300;
export const REASON_MAX = 500;

export const ISSUER_STATES = ['proposed', 'active', 'closed-to-new', 'derecognised'] as const;
export type IssuerState = (typeof ISSUER_STATES)[number];

export interface IssuerRow {
  readonly issuerId: string;
  readonly typeId: string;
  readonly typeCode: string;
  readonly displayName: string;
  readonly accreditationNumber: string | null;
  readonly state: IssuerState;
  readonly version: number;
  readonly stateChangedAt: string;
}

export interface IssuerPage {
  readonly items: readonly IssuerRow[];
  readonly nextAfterId: string | null;
}

export interface ProposalAction {
  readonly allowed: boolean;
  readonly code?: string;
}

/** A reactivation waiting for a second admin (the fields the card shows). */
export interface Proposal {
  readonly id: string;
  readonly proposedAt: string;
  readonly state: string;
  /** The version the proposal was read at; sent with approve, reject and withdraw. */
  readonly version: number;
  readonly reason?: { readonly state: string; readonly text?: string } | null;
  readonly actions: {
    readonly approve: ProposalAction;
    readonly reject: ProposalAction;
    readonly withdraw: ProposalAction;
  };
}

export interface IssuerDetail extends IssuerRow {
  readonly stateChangedByKind: 'admin' | 'seed';
  readonly expertReferenceRecorded: boolean;
  /** Approved certificates naming this issuer now. */
  readonly affectedCertificates: number;
  readonly pendingReactivation: Proposal | null;
  readonly createdAt: string;
}

export interface ExpertReference {
  readonly confirmedBy: string;
  readonly reference: string;
}

export interface ExpertReferenceView {
  readonly issuerId: string;
  readonly current: ExpertReference | null;
}

/** A certificate type the Market has, from certification/admin/types. */
export interface TypeChoice {
  readonly typeId: string;
  readonly code: string;
  readonly names: Readonly<Record<string, string>>;
}
