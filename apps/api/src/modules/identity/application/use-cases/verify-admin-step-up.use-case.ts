import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { AdminStepUpVerifiedAudit } from '../../domain/audit';
import { STEP_UP_ACTION_KEYS, stepUpAudienceOf } from '../../domain/step-up';
import { spendCode } from '../second-factor/code-check';
import {
  codeField,
  logOutcome,
  type FactorCodeInput,
  type FactorDeviceDependencies,
  type FactorStepFailure,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import { isActingAsSession } from '../sellers/access-decision-reads';
import type { StepUpRepository } from '../ports/step-up.repository';

export interface VerifyAdminStepUpInput extends FactorCodeInput {
  readonly actionKey: string;
}

export interface VerifyAdminStepUpOutput {
  readonly code: 'step-up-verified';
  readonly actionKey: string;
}

export type VerifyAdminStepUpFailure =
  | FactorStepFailure
  /** The action key is not a registered admin step-up action. */
  | { readonly code: 'step-up.action-unknown' };

export interface VerifyAdminStepUpDependencies extends FactorDeviceDependencies {
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
}

type AdminStepUpKey = (typeof STEP_UP_ACTION_KEYS)[number];

/**
 * A platform admin presents a fresh code for one admin action (issue #491). Rule `own-resources`:
 * the admin's own factor, the one used at admin sign-in; nothing in the input names an account.
 * The code (app or recovery code) is checked and spent like every signed-in admin code
 * ({@link SignedInFactorStep} with population `admin`: counted on the account's
 * `second-factor.account` counter, the same one admin sign-in uses, and locked after too many
 * wrong ones). In the unit that spends it the session gets a proof for this action only, and
 * `identity.admin-step-up.verified` is audited; `RequireStepUp` accepts the proof for
 * `STEP_UP_PROOF_MINUTES`. An acting-as session is refused. Refusals: `step-up.action-unknown`
 * (not a registered admin action), `second-factor.invalid`, `second-factor.locked`,
 * `second-factor.unavailable` (no active two-step).
 */
export class VerifyAdminStepUp extends UseCase<
  VerifyAdminStepUpInput,
  VerifyAdminStepUpOutput,
  VerifyAdminStepUpFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.verify-admin-step-up',
    rule: { kind: 'own-resources' },
    // Admin accounts only: the step refuses any other population before a seller check matters.
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('VerifyAdminStepUp');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: VerifyAdminStepUpDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'admin');
  }

  protected async handle(
    context: CallContext,
    input: VerifyAdminStepUpInput,
  ): Promise<Result<VerifyAdminStepUpOutput, VerifyAdminStepUpFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const action =
      typeof input?.actionKey === 'string'
        ? this.deps.stepUpActions.get(input.actionKey)
        : undefined;
    if (
      action === undefined ||
      stepUpAudienceOf(action) !== 'admin' ||
      !(STEP_UP_ACTION_KEYS as readonly string[]).includes(action.key)
    ) {
      return err({ code: 'step-up.action-unknown' });
    }
    const actionKey = action.key as AdminStepUpKey;
    const presented = codeField(input?.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    const sessionId = actor.sessionId;
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: async ({ account, now }) => {
        await this.deps.stepUp.recordProof(market, sessionId, actionKey, now);
        await this.deps.audit.record(
          context,
          AdminStepUpVerifiedAudit.entry(account.state.id, { after: { sessionId, actionKey } }),
        );
        return ok({ code: 'step-up-verified' as const, actionKey });
      },
    });
    logOutcome(
      this.#logger,
      'identity.admin-step-up.verify',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
