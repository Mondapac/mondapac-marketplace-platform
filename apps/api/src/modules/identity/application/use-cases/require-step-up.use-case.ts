import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../sellers/access-decision-reads';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { STEP_UP_PROOF_MINUTES, type StepUpFailure } from '../../contracts/step-up';
import { proofCovers, stepUpAudienceOf, stepUpRequired } from '../../domain/step-up';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { StepUpRepository } from '../ports/step-up.repository';

export interface RequireStepUpInput {
  readonly actionKey: string;
}

export interface RequireStepUpDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly clock: Clock;
}

/**
 * Asks whether a sensitive seller action may go ahead now (seller OTP policy; the use case behind
 * `IdentityFacade.requireStepUp`). Rule `own-resources`, approved sellers only. For a seller
 * session it reads the shop's rule for the registered action (the platform floor first, then the
 * shop's own rule, then the default). A rule that does not require a code lets the action through.
 * A required one needs a proof of this session for this action from the last
 * {@link STEP_UP_PROOF_MINUTES} minutes (`VerifySellerStepUp` writes it): without it the answer is
 * `second-factor.required`, and `second-factor.enrolment-required` when the member has no active
 * two-step yet. A caller that is not a seller session (an admin's own route, the system) is not
 * subject to a shop's rule. An unregistered key is a coding error and answers
 * `access.unavailable`, so the action stays closed. Read-only: nothing here changes.
 *
 * Admin actions (issue #491; registered with `audience: 'admin'`): an admin session ALWAYS needs a
 * proof of this session for this action from the last {@link STEP_UP_PROOF_MINUTES} minutes,
 * made with the admin's own active factor (`VerifyAdminStepUp` writes it); there is no per-shop
 * rule. Any other caller of an admin action is refused `access.denied`. An acting-as session is
 * refused for every action.
 */
export class RequireStepUp extends UseCase<
  RequireStepUpInput,
  { readonly code: 'step-up.satisfied' },
  StepUpFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.require-step-up',
    rule: { kind: 'own-resources' },
    // Whether the shop may sell is the guarded action's own rule; this only reads its two-step rule.
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('RequireStepUp');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequireStepUpDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequireStepUpInput,
  ): Promise<Result<{ readonly code: 'step-up.satisfied' }, StepUpFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const action = this.deps.stepUpActions.get(input.actionKey);
    if (action === undefined) {
      this.#logger.error({
        msg: 'identity.require-step-up.unregistered-action',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const { accountId, sessionId } = actor;
    if (stepUpAudienceOf(action) === 'admin') {
      // The platform floor for every admin action: always a fresh code, no rule to read.
      if (actor.population !== 'admin') return err({ code: 'access.denied' });
      return this.deps.unitOfWork.run<{ readonly code: 'step-up.satisfied' }, StepUpFailure>(
        market,
        () => this.proven(market, accountId, sessionId, action.key),
        { readOnly: true },
      );
    }
    if (actor.population !== 'seller') return ok({ code: 'step-up.satisfied' });
    if (actor.sellerId === null) return err({ code: 'access.denied' });
    const sellerId = actor.sellerId;
    return this.deps.unitOfWork.run<{ readonly code: 'step-up.satisfied' }, StepUpFailure>(
      market,
      async () => {
        const rule = await this.deps.stepUp.policyOf(market, sellerId, action.key);
        if (!stepUpRequired(action, rule ?? undefined)) return ok({ code: 'step-up.satisfied' });
        return this.proven(market, accountId, sessionId, action.key);
      },
      { readOnly: true },
    );
  }

  /** Whether this session holds a proof for this action made with the account's active factor. */
  private async proven(
    market: MarketContext,
    accountId: Id<'Account'>,
    sessionId: Id<'Session'>,
    actionKey: string,
  ): Promise<Result<{ readonly code: 'step-up.satisfied' }, StepUpFailure>> {
    const factor = await this.deps.factors.findByAccount(market, accountId);
    if (factor === null || !factor.isActive) {
      return err({ code: 'second-factor.enrolment-required', actionKey });
    }
    const verifiedAt = await this.deps.stepUp.proofOf(market, sessionId, actionKey);
    // (Replacing the device keeps `activatedAt`, so a proof lives out its five minutes;
    // follow-up package.)
    const covered = proofCovers(verifiedAt === null ? null : { sessionId, actionKey, verifiedAt }, {
      sessionId,
      actionKey,
      now: this.deps.clock.now(),
      factorActivatedAt: factor.state.activatedAt,
      minutes: STEP_UP_PROOF_MINUTES,
    });
    return covered
      ? ok({ code: 'step-up.satisfied' })
      : err({ code: 'second-factor.required', actionKey });
  }
}
