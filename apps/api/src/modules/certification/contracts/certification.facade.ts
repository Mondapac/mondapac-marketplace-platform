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

/**
 * `assertCategoriesRetirable` refused (design 3.7, 8.1; B2): a `NOT_APPLICABLE` or
 * `SELLER_REQUIRED` row of a published or pending policy revision names one of the categories.
 * The codes of those types, sorted; an admin moves or removes the rows first.
 */
export interface CategoryReferencedByPolicy {
  readonly code: 'category.referenced-by-policy';
  readonly typeCodes: readonly string[];
}

/** What `platformCategoriesRetired` did: new flags, and how many of them name a relaxing row. */
export interface RetiredCategoriesFlagged {
  readonly flagged: number;
  readonly relaxing: number;
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
   * The locales in which every type of the Market has at least one claim term, sorted. A text in
   * any other locale cannot be checked for claim words, so a caller refuses it (fail closed). A
   * failed or incomplete read is `certification.unavailable`. Rule `anonymous`.
   */
  claimTermLocales(context: CallContext): Promise<Result<readonly string[], Failure>>;

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
   * Before `catalog` moves, merges or archives platform categories (design 3.7, 8.1; C-4; B2;
   * ADR-0028 d5): `ok`, or `category.referenced-by-policy` with the type codes while a
   * `NOT_APPLICABLE` or `SELLER_REQUIRED` row of a policy's published revision, or of the revision
   * a pending relaxation would publish, names one of the ids (such a row stops matching once the
   * category is gone, and its lapse could relax a claim). `SELLER_OR_MANUFACTURER` rows do not
   * block. A move passes the moved subtree and its old ancestors that are not ancestors after the
   * move (a row on such an ancestor stops matching the moved products' paths); a merge passes the
   * source and its ancestors that are not the target's; an archive passes the category and each
   * ancestor that some product on it leaves (one its remaining live categories are not under).
   * Each also passes the `merged` categories whose products resolve to an id it passes. 1 to 5000
   * distinct ids; an empty, larger or malformed call is refused whole. A failed read is
   * `certification.unavailable`: the caller refuses its change (fail closed). The answer is the
   * same for every caller. Two use cases: `anonymous` for request actors, `system` for handlers
   * and jobs. Not exposed over HTTP.
   */
  assertCategoriesRetirable(
    context: CallContext,
    categoryIds: readonly string[],
  ): Promise<Result<void, Failure | CategoryReferencedByPolicy>>;

  /**
   * The backstop after `catalog`'s commit of a move, merge or archive (design 3.7, 8.1; C-4), with
   * the same ids the check cleared (for a move: the ids that left the products' paths): flags every
   * id a published or pending policy row names, once, and alerts the admins (a security event)
   * when a flagged category has a `NOT_APPLICABLE` or `SELLER_REQUIRED` row. Never rewrites a row.
   * Idempotent. Rule `system` (`catalog`'s own handler of its events, outside its unit). A fault is
   * `certification.unavailable`; the handler retries.
   */
  platformCategoriesRetired(
    context: CallContext,
    categoryIds: readonly string[],
  ): Promise<Result<RetiredCategoriesFlagged, Failure>>;

  /**
   * For the sellers admin list (SEL-10, CERT-30): per requested seller (at most 100 distinct ids),
   * the type codes with a valid certificate and with one awaiting review. Admin callers holding
   * `certification.seller-certificate.view` only; the claim is decided by `evaluateClaims` alone.
   */
  sellerCertificateOverview(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<Result<readonly SellerCertificateOverviewRow[], Failure>>;

  /**
   * Multi-culture (ADR-0047 decisions 3 and 5, ADR-0048 security review M2): per requested seller
   * (at most 100 distinct ids, one row each), the codes of the types the seller holds a valid
   * certificate of now (the measure of `sellerCertificateOverview`). Type codes only, no
   * certificate data and no review state. A membership precondition for a culture with a required
   * certification type, never a claim (`evaluateClaims` alone decides a tag). Two use cases:
   * `anonymous` for request actors, `system` for handlers and jobs. A failed read is
   * `certification.unavailable`, never an empty answer: callers fail closed. Not exposed over HTTP.
   */
  sellerValidCertificateTypes(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<Result<readonly SellerValidCertificateTypesRow[], Failure>>;
}

/** What `sellerValidCertificateTypes` answers per seller: type codes only. */
export interface SellerValidCertificateTypesRow {
  readonly sellerId: Id<'Seller'>;
  readonly validTypeCodes: readonly string[];
}

/** Nest token of the {@link CertificationFacade}, provided and exported by `CertificationModule`. */
export const CERTIFICATION_FACADE = Symbol('CERTIFICATION_FACADE');
