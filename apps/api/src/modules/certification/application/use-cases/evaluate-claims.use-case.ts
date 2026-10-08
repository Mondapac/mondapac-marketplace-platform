import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationValidationFailed } from '../../contracts/certification.facade';
import type { ClaimDecision } from '../../domain/claim-types';
import { evaluateClaimsFor } from '../evaluate-claims';
import type { ClaimFactsReader, SellerZonesSource } from '../ports/claim-facts.ports';

export interface EvaluateClaimsInput {
  readonly queries: readonly unknown[];
}

/**
 * `evaluateClaims` for request actors: rule `anonymous`; its pair is the `system` case. Nothing of the actor is read, so the
 * answer is the same for every caller (design 7.4).
 */
export class EvaluateClaims extends UseCase<
  EvaluateClaimsInput,
  readonly ClaimDecision[],
  CertificationValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.evaluate-claims',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly facts: ClaimFactsReader,
    private readonly zones: SellerZonesSource,
    private readonly clock: Clock,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: EvaluateClaimsInput,
  ): Promise<Result<readonly ClaimDecision[], CertificationValidationFailed>> {
    return evaluateClaimsFor(
      { facts: this.facts, zones: this.zones, now: () => this.clock.now() },
      context,
      input.queries,
    );
  }
}
