import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../sellers/access-decision-reads';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { spendCode } from '../second-factor/code-check';
import {
  codeField,
  logOutcome,
  type FactorCodeInput,
  type FactorDeviceDependencies,
  type FactorStepFailure,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import { stepUpAudienceOf } from '../../domain/step-up';
import type { StepUpRepository } from '../ports/step-up.repository';

export interface VerifySellerStepUpInput extends FactorCodeInput {
  readonly actionKey: string;
}

export interface VerifySellerStepUpOutput {
  readonly code: 'step-up-verified';
  readonly actionKey: string;
}

export type VerifySellerStepUpFailure =
  | FactorStepFailure
  /** The action key is not a registered step-up action. */
  | { readonly code: 'step-up.action-unknown' };

export interface VerifySellerStepUpDependencies extends FactorDeviceDependencies {
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
}

/**
 * Presents a code for one action (seller OTP policy). Rule `own-resources`, approved sellers only.
 * The code (app or recovery code) is checked and spent like every signed-in code
 * ({@link SignedInFactorStep}: counted on the account's code counter, locked after too many
 * wrong ones). In the unit that spends it the session gets a proof for this action only; the
 * guarded use case accepts it for the next few minutes (`RequireStepUp`). The action must be
 * registered. Refusals: `step-up.action-unknown`, `second-factor.invalid`,
 * `second-factor.locked`, `second-factor.unavailable` (no active two-step: set it up first).
 */
export class VerifySellerStepUp extends UseCase<
  VerifySellerStepUpInput,
  VerifySellerStepUpOutput,
  VerifySellerStepUpFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.verify-seller-step-up',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('VerifySellerStepUp');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: VerifySellerStepUpDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'seller');
  }

  protected async handle(
    context: CallContext,
    input: VerifySellerStepUpInput,
  ): Promise<Result<VerifySellerStepUpOutput, VerifySellerStepUpFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || isActingAsSession(actor)) {
      return err({ code: 'access.denied' });
    }
    const action =
      typeof input?.actionKey === 'string'
        ? this.deps.stepUpActions.get(input.actionKey)
        : undefined;
    // An admin action is proven on the admin route only (issue #491).
    if (action === undefined || stepUpAudienceOf(action) !== 'seller') {
      return err({ code: 'step-up.action-unknown' });
    }
    const presented = codeField(input?.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    const sessionId = actor.sessionId;
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: async ({ now }) => {
        await this.deps.stepUp.recordProof(market, sessionId, action.key, now);
        return ok({ code: 'step-up-verified' as const, actionKey: action.key });
      },
    });
    logOutcome(
      this.#logger,
      'identity.seller-step-up.verify',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
