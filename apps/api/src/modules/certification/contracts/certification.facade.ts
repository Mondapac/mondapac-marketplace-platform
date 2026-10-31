import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ClaimTermMatch } from '../domain/claim-text-matcher';
import type { ClaimDecision, ClaimQuery } from '../domain/claim-types';
import type { CertificationTypeCode } from '../domain/claim-types';
import type { TypeDefaultBasis, VerificationMode } from '../domain/type-revision';

/** A request the facade refused before any read: a code and the fields, never their values. */
export interface CertificationValidationFailed {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/** The read failed. There is no partial answer; callers fail closed (design 4.6, M8). */
export interface CertificationUnavailable {
  readonly code: 'certification.unavailable';
}

/** What `sellerCertificateOverview` answers per seller: type codes only, no certificate fields. */
export interface SellerCertificateOverviewRow {
  readonly sellerId: Id<'Seller'>;
  /** Codes of the types the seller holds a valid certificate of (a display measure; not a claim). */
  readonly validTypeCodes: readonly string[];
  /** Codes of the types with a submission waiting for review. */
  readonly awaitingReviewTypeCodes: readonly string[];
}

/** One text to check. The locale is the text's declared one; the match ignores it (M8). */
export interface ClaimTextInput {
  readonly locale: string;
  readonly text: string;
}

/** What `certificationTypes` answers per type (design 8.1). No claim terms. */
export interface CertificationTypeView {
  /** The type's id (slice 14: catalog maps the `typeId` of an event payload to a code). */
  readonly typeId: Id;
  readonly code: CertificationTypeCode;
  readonly status: 'active' | 'inactive';
  readonly publishedRevisionId: Id;
  readonly verificationMode: VerificationMode;
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly defaultBasis: TypeDefaultBasis;
  readonly autoApproveSelfDeclaration: boolean;
  readonly badgeIconKey: string;
  readonly locales: Readonly<
    Record<string, { readonly name: string; readonly customerDescription: string }>
  >;
}

type Failure = AccessDenied | CertificationValidationFailed | CertificationUnavailable;

/**
 * The public facade of `certification` (design 8.1). Every method takes the caller's
 * `CallContext` first, unchanged, and is a thin call of one use case, so the gate runs. Not
 * exposed over HTTP. `evaluateClaims` joins in slice 1's use-case part.
 */
export interface CertificationFacade {
  /**
   * The one question "may this seller carry this certification tag on this Offer" (design 4.1,
   * CERT-21; ADR-0028 d1 and d2). 1 to 100 queries; a malformed query answers `input-invalid`
   * and the others still answer; any fault answers `unavailable` for every query of the batch
   * (fail closed; nothing cached). A decision is valid only in the request that asked: callers
   * ask again at each moment and accept it only when its `inputs` equal the state they save. The
   * actor is never read; the answer is the same for every caller. Two use cases: `anonymous`
   * for request actors, `system` for handlers and jobs. Not exposed over HTTP.
   */
  evaluateClaims(
    context: CallContext,
    queries: readonly ClaimQuery[],
  ): Promise<Result<readonly ClaimDecision[], AccessDenied | CertificationValidationFailed>>;

  /**
   * Per text, in order, the type codes whose published claim terms (every locale of the Market,
   * active or inactive types) occur in it, with the token span of a first-pass match. At most
   * 100 texts of at most 20000 characters; a larger or malformed call is refused whole. The
   * answer is the same for every caller. A failed read is `certification.unavailable`, never an
   * empty answer: the consumer refuses the save (fail closed; M8). Two use cases behind this
   * method: `anonymous` for a request actor, `system` for handlers and jobs.
   */
  matchClaimTerms(
    context: CallContext,
    texts: readonly ClaimTextInput[],
  ): Promise<Result<readonly (readonly ClaimTermMatch[])[], Failure>>;

  /**
   * The Market's published claim terms as plain phrases (NFKC, lower case, tokens joined by single spaces),
   * deduplicated and sorted, for a panel that warns while a user types. Not a decision: the
   * save-time `matchClaimTerms` stays authoritative. A failed or incomplete read is
   * `certification.unavailable`, never an empty list. The answer is the same for every caller.
   */
  claimTermList(
    context: CallContext,
  ): Promise<Result<readonly string[], AccessDenied | CertificationUnavailable>>;

  /**
   * The Market's types with their published revision's form settings and texts, in code order.
   * `status` filters. Same pair of use cases and the same fail-closed read.
   */
  certificationTypes(
    context: CallContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<Result<readonly CertificationTypeView[], Failure>>;

  /**
   * The Market's platform categories that certification marks: every category a published claim
   * policy row names with a basis other than `NOT_APPLICABLE`, for every type, active or
   * inactive, sorted. Consumers that must never use a certification as a signal (the buyer's
   * "for you" shelf) leave these categories out. Ids only; no type, no basis. Rule `anonymous`
   * (the answer is the same for every caller). A failed read is `certification.unavailable`,
   * never an empty answer: the consumer fails closed. Not exposed over HTTP.
   */
  certifiedCategoryIds(
    context: CallContext,
  ): Promise<Result<readonly Id<'Category'>[], AccessDenied | CertificationUnavailable>>;

  /**
   * For the sellers admin list (SEL-10, CERT-30): per requested seller (at most 100 distinct ids),
   * the type codes with a valid certificate and with one awaiting review. Admin callers holding
   * `certification.seller-certificate.view` only; the claim is decided by `evaluateClaims` alone.
   */
  sellerCertificateOverview(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<Result<readonly SellerCertificateOverviewRow[], Failure>>;
}

/** Nest token of the {@link CertificationFacade}, provided and exported by `CertificationModule`. */
export const CERTIFICATION_FACADE = Symbol('CERTIFICATION_FACADE');
