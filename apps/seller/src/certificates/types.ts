// The seller's own certificates as the certification API answers them (certification design 7.2;
// own-certificate.dto.ts). Every type name, issuer, form setting and status comes from the API:
// the panel never names a certification type, a Market or a file limit itself.

export const CERTIFICATE_VIEW_PERMISSION = 'certification.own-certificate.view';
export const CERTIFICATE_MANAGE_PERMISSION = 'certification.own-certificate.manage';

/** The list page (Settings › Store › Certificates). */
export const CERTIFICATES_PATH = '/settings/certificates';

export const certificatePath = (certificateId: string): string =>
  `${CERTIFICATES_PATH}/${certificateId}`;

/** The seller-visible statuses (certification design 3.3; ux.md 3.2). */
export const CERTIFICATE_STATUSES = [
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
] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export interface CertificateSummary {
  readonly certificateId: string;
  readonly typeCode: string;
  /** A seller-visible status; a code this panel does not know is shown as "unknown". */
  readonly status: string;
  readonly recordStatus: string;
  readonly submitBy: string | null;
  readonly editable: boolean;
  readonly deletable: boolean;
  readonly withdrawable: boolean;
  readonly createdAt: string;
  readonly lastChangedAt: string;
  /** Sent once the server adds them (seller certificates PR 1); "—" until then. */
  readonly issuerName?: string | null;
  readonly validUntil?: string | null;
}

export interface CertificateList {
  readonly certificates: readonly CertificateSummary[];
  readonly nextAfterId: string | null;
}

export interface CertificateDraft {
  readonly issuerId: string | null;
  readonly certificateNumber: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNote: string | null;
}

export interface CertificateDocument {
  readonly documentId: string;
  readonly position: number;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly createdAt: string;
}

export interface CertificateDetail {
  readonly certificate: CertificateSummary;
  readonly draft: CertificateDraft;
  readonly documents: readonly CertificateDocument[];
}

export interface CertificateDraftSaved {
  readonly certificate: CertificateSummary;
  readonly draft: CertificateDraft;
  readonly withdrawnSubmissionId: string | null;
}

export interface CertificateIssuerOption {
  readonly issuerId: string;
  readonly displayName: string;
}

export interface CertificateTypeOption {
  readonly code: string;
  /** The type's name by locale code, as the Market set it. */
  readonly names: Readonly<Record<string, string>>;
  /** `THIRD_PARTY_DOCUMENT` or `SELF_DECLARATION`; a mode this panel does not know reads as a document. */
  readonly verificationMode: string;
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly issuers: readonly CertificateIssuerOption[];
}

export interface CertificateOptions {
  readonly types: readonly CertificateTypeOption[];
}

/** The longest certificate number the API takes. */
export const CERTIFICATE_NUMBER_MAX = 64;
/** The longest self-declaration note the API takes. */
export const DECLARATION_NOTE_MAX = 1000;

/**
 * The type's name in the panel's language: the exact locale, then its language, then English,
 * then any name the Market gave, then the code itself.
 */
export function typeName(
  names: Readonly<Record<string, string>> | undefined,
  code: string,
  locale: string,
): string {
  if (names === undefined) return code;
  const language = locale.split('-')[0] ?? locale;
  const pick =
    names[locale] ??
    names[language] ??
    Object.entries(names).find(([key]) => key.split('-')[0] === language)?.[1] ??
    names['en'] ??
    Object.values(names)[0];
  return typeof pick === 'string' && pick.trim() !== '' ? pick : code;
}

/**
 * The seller account's state beside the certificates (CERT-12: the account and a certificate are
 * two states, never one). Before approval the account setup's own status says where it stands.
 */
export type SellerAccountState =
  | 'approved'
  | 'details-incomplete'
  | 'ready'
  | 'outside-area'
  | 'awaiting-review'
  | 'changes-needed'
  | 'not-approved';
