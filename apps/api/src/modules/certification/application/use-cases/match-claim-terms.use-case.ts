import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ClaimTextInput } from '../../contracts/certification.facade';
import { matchClaimTermsFor, type QueryFailure } from '../queries';
import type { PublishedTypesReader } from '../ports/published-types.reader';
import type { ClaimTermMatch } from '../../domain/claim-text-matcher';

export interface MatchClaimTermsInput {
  readonly texts: readonly ClaimTextInput[];
}

/** `matchClaimTerms` for request actors: rule `anonymous`; its pair is the `system` case. The answer is the same for every caller. */
export class MatchClaimTerms extends UseCase<
  MatchClaimTermsInput,
  readonly (readonly ClaimTermMatch[])[],
  QueryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.match-claim-terms',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly reader: PublishedTypesReader,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: MatchClaimTermsInput,
  ): Promise<Result<readonly (readonly ClaimTermMatch[])[], QueryFailure>> {
    return matchClaimTermsFor(this.reader, context, input.texts);
  }
}
