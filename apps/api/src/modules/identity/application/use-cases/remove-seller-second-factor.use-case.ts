import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SecondFactorResetAudit } from '../../domain/audit';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { spendCode } from '../second-factor/code-check';
import {
  type FactorCodeInput,
  type FactorDeviceDependencies,
  type FactorStepFailure,
  codeField,
  logOutcome,
} from '../second-factor/factor-device';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';

/** The factor is gone; the account signs in with its password alone again. */
export interface RemoveSellerSecondFactorOutput {
  readonly code: 'second-factor-removed';
}

export interface RemoveSellerSecondFactorDependencies extends FactorDeviceDependencies {
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
}

/**
 * Switches the signed-in seller-side account's own second factor off (identity design 3.6
 * `active` → `none`; owner decision 2026-10-08: optional for a seller at launch). Rule
 * `own-resources`, approved sellers only. A code from the app or a recovery code proves the
 * holder ({@link SignedInFactorStep}: counted on `second-factor.account`, spent once), so a
 * hijacked session without the device cannot remove the factor.
 *
 * In the closing unit: the factor's last version step (`recordReset`), its removal with its
 * recovery codes, every other session of the account revoked (`second-factor-reset`; this
 * session continues), every open challenge void, `identity.second-factor-changed.v1` (`reset`:
 * the alert mail to the holder) and `identity.second-factor.reset` as the holder.
 *
 * Whether a seller may do this once payouts need the factor is the payouts module's rule, not
 * this use case's.
 */
export class RemoveSellerSecondFactor extends UseCase<
  FactorCodeInput,
  RemoveSellerSecondFactorOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.remove-seller-second-factor',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('RemoveSellerSecondFactor');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: RemoveSellerSecondFactorDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'seller');
  }

  protected async handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<RemoveSellerSecondFactorOutput, FactorStepFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const presented = codeField(input.code, true);
    if (!presented.ok) return presented;
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.secretCiphertext,
      spend: (factor, check, now) =>
        spendCode(this.deps.factors, market, factor.state.id, check, now),
      succeed: async ({ account, factor, now }) => {
        const accountId = account.state.id;
        const before = factor.state.state;
        factor.recordReset(now);
        await this.deps.factors.removeOf(market, accountId);
        await this.deps.sessions.revokeAllOf(
          market,
          accountId,
          'second-factor-reset',
          now,
          actor.sessionId,
        );
        await this.deps.challenges.voidAllOf(market, accountId);
        await this.deps.outbox.append(context, factor.pendingEvents);
        await this.deps.audit.record(
          context,
          SecondFactorResetAudit.entry(factor.state.id, {
            before: { state: before },
            after: { accountId },
          }),
        );
        return ok({ code: 'second-factor-removed' as const });
      },
    });
    logOutcome(
      this.#logger,
      'identity.seller-second-factor.remove',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
