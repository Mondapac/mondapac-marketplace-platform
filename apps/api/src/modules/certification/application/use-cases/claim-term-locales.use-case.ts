import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationUnavailable } from '../../contracts/certification.facade';
import { claimTermLocalesFor } from '../queries';
import type { PublishedTypesReader } from '../ports/published-types.reader';

/**
 * `claimTermLocales` for request actors: rule `anonymous`, like `matchClaimTerms` (an admin's save
 * asks it before checking its texts). The answer is the same for every caller.
 */
export class ClaimTermLocales extends UseCase<
  Record<string, never>,
  readonly string[],
  CertificationUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-term-locales',
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
  ): Promise<Result<readonly string[], CertificationUnavailable>> {
    return claimTermLocalesFor(this.reader, context);
  }
}
