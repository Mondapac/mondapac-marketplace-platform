import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { spendCode } from '../second-factor/code-check';
import {
  type FactorCodeInput,
  type FactorDeviceDependencies,
  type FactorStepFailure,
  codeField,
  logOutcome,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';

/** The holder presented a current code: nothing else changed. */
export interface ConfirmSellerSecondFactorOutput {
  readonly code: 'second-factor-confirmed';
}

/**
 * Proves, right now, that the signed-in seller-side account's holder has its second factor (a
 * "recent confirmation" another module asks for before a sensitive change, for example the payout
 * account of `payments`). Rule `own-resources`, approved sellers only. A code from the app or a
 * recovery code is checked by {@link SignedInFactorStep}: counted on `second-factor.account`
 * like every signed-in code, spent once. The step has no other effect: no factor, session or
 * secret changes, and the only record is the outcome log line (a code is never logged).
 * Refusals: `second-factor.invalid`, `second-factor.locked`, and `second-factor.unavailable`
 * when the account has no active factor.
 */
export class ConfirmSellerSecondFactor extends UseCase<
  FactorCodeInput,
  ConfirmSellerSecondFactorOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-seller-second-factor',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ConfirmSellerSecondFactor');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: FactorDeviceDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'seller');
  }

  protected async handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<ConfirmSellerSecondFactorOutput, FactorStepFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const presented = codeField(input?.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: () => Promise.resolve(ok({ code: 'second-factor-confirmed' as const })),
    });
    logOutcome(
      this.#logger,
      'identity.seller-second-factor.confirm',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
