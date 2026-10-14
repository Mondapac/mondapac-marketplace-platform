import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  FactorCodeInput,
  FactorDeviceDependencies,
  FactorStepFailure,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import {
  regenerateRecoveryCodes,
  type RegenerateRecoveryCodesOutput,
} from './regenerate-recovery-codes.use-case';

/**
 * Regenerates the recovery codes of the signed-in seller-side account's own second factor (owner
 * decision 2026-10-08: optional for a seller at launch). The admin's {@link RegenerateRecoveryCodes}
 * does the same for an admin; both run {@link regenerateRecoveryCodes} over a step fixed to
 * their population, so the step refuses the other one. Rule `own-resources`, approved sellers
 * only.
 */
export class RegenerateSellerRecoveryCodes extends UseCase<
  FactorCodeInput,
  RegenerateRecoveryCodesOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.regenerate-seller-recovery-codes',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('RegenerateSellerRecoveryCodes');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: FactorDeviceDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'seller');
  }

  protected handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<RegenerateRecoveryCodesOutput, FactorStepFailure>> {
    return regenerateRecoveryCodes(this.deps, this.#step, this.#logger, context, input);
  }
}
