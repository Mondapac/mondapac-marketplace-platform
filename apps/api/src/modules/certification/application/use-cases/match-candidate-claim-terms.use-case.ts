import { err } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_EDIT } from '../../contracts/permissions';
import type { CandidateClaimTerms, ClaimTextInput } from '../../contracts/certification.facade';
import type { ClaimTermMatch } from '../../domain/claim-text-matcher';
import type { CertificationTypeCode } from '../../domain/claim-types';
import { isCertificationTypeCode, validateCandidateClaimTerms } from '../../domain/type-revision';
import { matchCandidateTermsFor, type QueryFailure } from '../queries';
import { reviewerOf } from '../review/review.shared';

export interface MatchCandidateClaimTermsInput {
  readonly candidate: CandidateClaimTerms;
  readonly texts: readonly ClaimTextInput[];
}

export type MatchCandidateClaimTermsFailure = QueryFailure | { readonly code: 'access.denied' };

type Answer = Result<readonly (readonly ClaimTermMatch[])[], QueryFailure>;

/** A code for a type not yet created: only labels the match, nothing is stored or published. */
const NEW_TYPE_CODE = 'candidate' as CertificationTypeCode;

/**
 * Validates the candidate the way `validateTypeRevision` checks a revision's terms, then matches
 * the texts against the candidate terms only. Refused whole, before any matching.
 */
function matchCandidate(
  supportedLocales: (market: MarketContext) => readonly string[],
  context: CallContext,
  input: MatchCandidateClaimTermsInput,
): Answer {
  const candidate = (input as Partial<MatchCandidateClaimTermsInput> | null)?.candidate as
    Partial<CandidateClaimTerms> | null | undefined;
  if (typeof candidate !== 'object' || candidate === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'candidate', code: 'type' }] });
  }
  const { typeCode, termsByLocale } = candidate;
  if (typeCode !== undefined && !isCertificationTypeCode(typeCode)) {
    return err({
      code: 'validation.failed',
      fields: [{ path: 'candidate.typeCode', code: 'format' }],
    });
  }
  const checked = validateCandidateClaimTerms(termsByLocale, supportedLocales(context.market));
  if (!checked.ok) {
    return err({ code: 'validation.failed', fields: checked.error.map((p) => ({ ...p })) });
  }
  return matchCandidateTermsFor(typeCode ?? NEW_TYPE_CODE, checked.value, input.texts);
}

/**
 * `matchCandidateClaimTerms` for a request actor (catalog request X-1, design 6.5): an
 * authenticated admin with `certification.type.edit`, never acting-as. Read-only; no unit.
 */
export class MatchCandidateClaimTerms extends UseCase<
  MatchCandidateClaimTermsInput,
  readonly (readonly ClaimTermMatch[])[],
  MatchCandidateClaimTermsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.match-candidate-claim-terms',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly supportedLocales: (market: MarketContext) => readonly string[],
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MatchCandidateClaimTermsInput,
  ): Promise<Result<readonly (readonly ClaimTermMatch[])[], MatchCandidateClaimTermsFailure>> {
    if (reviewerOf(context, { write: true }) === null) {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return Promise.resolve(matchCandidate(this.supportedLocales, context, input));
  }
}

/** The `system` pair, for jobs and handlers (same answer). */
export class MatchCandidateClaimTermsSystem extends UseCase<
  MatchCandidateClaimTermsInput,
  readonly (readonly ClaimTermMatch[])[],
  QueryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.match-candidate-claim-terms-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly supportedLocales: (market: MarketContext) => readonly string[],
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: MatchCandidateClaimTermsInput): Promise<Answer> {
    return Promise.resolve(matchCandidate(this.supportedLocales, context, input));
  }
}
