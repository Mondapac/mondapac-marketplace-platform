import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type {
  ConsumedStepUp,
  StepUpActionRegistry,
  StepUpProofConsumer,
  StepUpRefusal,
} from '../../../../platform/authz';
import { STEP_UP_PROOF_MINUTES } from '../../contracts/step-up';
import { proofCovers, stepUpAudienceOf } from '../../domain/step-up';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { StepUpRepository } from '../ports/step-up.repository';
import { isActingAsSession } from '../sellers/access-decision-reads';

export interface AdminStepUpConsumerDependencies {
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly clock: Clock;
}

/**
 * identity's side of `STEP_UP_CONSUMER` (issue #491; Hassan L1, L2): spends the proof of an admin
 * action once, inside the caller's open read-write unit, right before the change it allows. It
 * opens no unit and passes no gate: the guarded use case has passed its own gate, and the gate
 * may not run inside an open unit. It checks everything again, fail closed: an admin session that
 * is not acting-as, a registered admin action, the account's active factor, and a proof of this
 * session for this action that is fresh and made with that factor ({@link proofCovers}). The
 * proof row is deleted whatever its age, so a stale proof is gone too when the caller commits; a
 * refusal makes the caller return `err`, so its unit commits nothing. Seller actions are not
 * consumed here: their proofs keep the seller OTP policy's five-minute window.
 */
export class AdminStepUpConsumer implements StepUpProofConsumer {
  constructor(private readonly deps: AdminStepUpConsumerDependencies) {}

  async consume(
    context: CallContext,
    actionKey: string,
  ): Promise<Result<ConsumedStepUp, StepUpRefusal>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.denied' });
    const action = this.deps.stepUpActions.get(actionKey);
    if (action === undefined) return err({ code: 'access.unavailable' });
    if (stepUpAudienceOf(action) !== 'admin') return err({ code: 'access.unavailable' });
    const factor = await this.deps.factors.findByAccount(market, actor.accountId);
    if (factor === null || !factor.isActive) {
      return err({ code: 'second-factor.enrolment-required', actionKey: action.key });
    }
    const sessionId = actor.sessionId;
    const verifiedAt = await this.deps.stepUp.takeProof(market, sessionId, action.key);
    const covered = proofCovers(
      verifiedAt === null ? null : { sessionId, actionKey: action.key, verifiedAt },
      {
        sessionId,
        actionKey: action.key,
        now: this.deps.clock.now(),
        factorActivatedAt: factor.state.activatedAt,
        minutes: STEP_UP_PROOF_MINUTES,
      },
    );
    if (!covered || verifiedAt === null) {
      return err({ code: 'second-factor.required', actionKey: action.key });
    }
    return ok({ sessionId, verifiedAt });
  }
}
