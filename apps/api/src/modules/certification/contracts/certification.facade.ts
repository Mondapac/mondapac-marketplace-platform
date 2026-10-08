import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ClaimTermMatch } from '../domain/claim-text-matcher';
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

/** One text to check. The locale is the text's declared one; the match ignores it (M8). */
export interface ClaimTextInput {
  readonly locale: string;
  readonly text: string;
}

/** What `certificationTypes` answers per type (design 8.1). No claim terms. */
export interface CertificationTypeView {
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
   * The Market's types with their published revision's form settings and texts, in code order.
   * `status` filters. Same pair of use cases and the same fail-closed read.
   */
  certificationTypes(
    context: CallContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<Result<readonly CertificationTypeView[], Failure>>;
}

/** Nest token of the {@link CertificationFacade}, provided and exported by `CertificationModule`. */
export const CERTIFICATION_FACADE = Symbol('CERTIFICATION_FACADE');
