import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationUnavailable } from '../../contracts/certification.facade';
import { claimTermListFor } from '../queries';
import type { PublishedTypesReader } from '../ports/published-types.reader';

/**
 * `claimTermList` for request actors: rule `anonymous`, the same answer for every caller (the
 * claim words are public to anyone who can write a text that is checked against them). The list
 * is plain phrases (NFKC, lower case, whole tokens), for a panel that warns while a user types; the match on save is the
 * authority.
 */
export class ClaimTermList extends UseCase<
  Record<string, never>,
  readonly string[],
  CertificationUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.claim-term-list',
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
    return claimTermListFor(this.reader, context);
  }
}
