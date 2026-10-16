import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { STEP_UP_POLICY_MANAGE } from '../../contracts/permissions';
import { SellerStepUpPolicyChangedAudit } from '../../domain/audit';
import { stepUpRequired, STEP_UP_ACTION_KEYS } from '../../domain/step-up';
import { spendCode } from '../second-factor/code-check';
import {
  codeField,
  logOutcome,
  type FactorDeviceDependencies,
  type FactorStepFailure,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import type { StepUpRepository } from '../ports/step-up.repository';

export interface SetSellerStepUpPolicyInput {
  readonly actionKey: string;
  readonly required: boolean;
  /** A current code of the Owner's two-step (app or recovery code). Saving a rule needs one. */
  readonly code: string;
}

export interface SetSellerStepUpPolicyOutput {
  /** `step-up-policy.changed`, or `step-up-policy.unchanged` (the rule already applies; no code is spent). */
  readonly code: 'step-up-policy.changed' | 'step-up-policy.unchanged';
  readonly actionKey: string;
  readonly required: boolean;
}

export type SetSellerStepUpPolicyFailure =
  | FactorStepFailure
  /** The action key is not a registered step-up action. */
  | { readonly code: 'step-up.action-unknown' }
  /** The platform floor: the action is always required and the shop cannot turn it off. */
  | { readonly code: 'step-up.locked' };

export interface SetSellerStepUpPolicyDependencies extends FactorDeviceDependencies {
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
}

/**
 * Makes one action require, or stop requiring, a fresh two-step code in the signed-in Owner's
 * shop (seller OTP policy). Rule `permissions [identity.step-up-policy.manage]` (protected: the
 * Seller Owner's alone), approved sellers only. The shop is the session's (R6). Order:
 *
 * 1. The action must be registered (`step-up.action-unknown`) and not locked (`step-up.locked`:
 *    the platform floor); a request that changes nothing answers `step-up-policy.unchanged`
 *    without spending a code.
 * 2. The Owner presents a current code, spent like every signed-in code; saving a rule is itself
 *    a sensitive action.
 * 3. In the unit that spends the code the rule is stored and the audit row
 *    `identity.seller-step-up-policy.changed` is written with the old and new effective value.
 *
 * A later turn-off of an action does not need the member to have two-step set up; a turn-on does
 * not lock members out: a member without two-step is asked to set it up on their next attempt.
 */
export class SetSellerStepUpPolicy extends UseCase<
  SetSellerStepUpPolicyInput,
  SetSellerStepUpPolicyOutput,
  SetSellerStepUpPolicyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.set-seller-step-up-policy',
    rule: { kind: 'permissions', allOf: [STEP_UP_POLICY_MANAGE.key] },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('SetSellerStepUpPolicy');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: SetSellerStepUpPolicyDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'seller');
  }

  protected async handle(
    context: CallContext,
    input: SetSellerStepUpPolicyInput,
  ): Promise<Result<SetSellerStepUpPolicyOutput, SetSellerStepUpPolicyFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const accountId = actor.accountId;
    const action =
      typeof input?.actionKey === 'string'
        ? this.deps.stepUpActions.get(input.actionKey)
        : undefined;
    if (action === undefined || !(STEP_UP_ACTION_KEYS as readonly string[]).includes(action.key)) {
      return err({ code: 'step-up.action-unknown' });
    }
    if (typeof input.required !== 'boolean') {
      return err({ code: 'validation.failed', fields: [{ path: 'required', code: 'format' }] });
    }
    const required = input.required;
    if (action.locked) return err({ code: 'step-up.locked' });
    const presented = codeField(input.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });

    const current = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.stepUp.policyOf(market, sellerId, action.key)),
      { readOnly: true },
    );
    if (!current.ok) return err({ code: 'access.unavailable' });
    if (stepUpRequired(action, current.value ?? undefined) === required) {
      return ok({ code: 'step-up-policy.unchanged', actionKey: action.key, required });
    }

    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: async ({ now }) => {
        const before = await this.deps.stepUp.policyOf(market, sellerId, action.key);
        await this.deps.stepUp.savePolicy(market, sellerId, action.key, required, accountId, now);
        await this.deps.audit.record(
          context,
          SellerStepUpPolicyChangedAudit.entry(sellerId, {
            before: {
              actionKey: action.key as (typeof STEP_UP_ACTION_KEYS)[number],
              required: stepUpRequired(action, before ?? undefined),
            },
            after: { actionKey: action.key as (typeof STEP_UP_ACTION_KEYS)[number], required },
          }),
        );
        return ok({
          code: 'step-up-policy.changed' as const,
          actionKey: action.key,
          required,
        });
      },
    });
    logOutcome(
      this.#logger,
      'identity.seller-step-up-policy.set',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
