import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ClaimTermMatch } from '../../domain/claim-text-matcher';
import type { QueryFailure } from '../queries';
import {
  matchCandidate,
  type MatchCandidateClaimTermsAnswer,
  type MatchCandidateClaimTermsInput,
} from './match-candidate-claim-terms.use-case';

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

  protected handle(
    context: CallContext,
    input: MatchCandidateClaimTermsInput,
  ): Promise<MatchCandidateClaimTermsAnswer> {
    return Promise.resolve(matchCandidate(this.supportedLocales, context, input));
  }
}
