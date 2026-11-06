import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AGENT_ACCOUNT_RESET_SECOND_FACTOR } from '../../contracts/permissions';
import { SecondFactorResetAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';

const RULE_KEYS = [AGENT_ACCOUNT_RESET_SECOND_FACTOR.key];

export interface ResetAgentSecondFactorInput {
  readonly accountId: Id<'Account'>;
}

export interface ResetAgentSecondFactorOutput {
  readonly code: 'second-factor.reset';
  readonly accountId: Id<'Account'>;
  readonly revokedSessions: number;
}

export type ResetAgentSecondFactorFailure =
  /** No agent account with this id in the Market: "not found". */
  | { readonly code: 'account.unknown' }
  /** The account has no factor: nothing to reset. */
  | { readonly code: 'second-factor.none' }
  | { readonly code: 'access.denied' };

export interface ResetAgentSecondFactorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly factors: SecondFactorRepository;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Resets an agent's second factor (ADR-0045 decision 3; the agent counterpart of
 * `ResetOtherAdminSecondFactor`). Rule `permissions [identity.agent-account.reset-second-factor]`
 * (protected); the route also asks for a fresh step-up code of the same key. One serializable
 * unit, the credential lock first: the acting admin re-read as active and holding the key
 * (`access.denied` otherwise), the target an agent account of the Market (`account.unknown`
 * otherwise, also for another population), the factor removed with its recovery codes, **every
 * session revoked** (`second-factor-reset`), **every open challenge void**, the
 * `second-factor-changed` event (`reset`) and `identity.second-factor.reset` as the actor. An
 * agent holds no role and no permission, so `canActOn` has no target key to compare: the actor
 * needs only the key. The reset opens no session, and the agent cannot sign in until a factor is
 * enrolled again.
 */
export class ResetAgentSecondFactor extends UseCase<
  ResetAgentSecondFactorInput,
  ResetAgentSecondFactorOutput,
  ResetAgentSecondFactorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reset-agent-second-factor',
    rule: { kind: 'permissions', allOf: [AGENT_ACCOUNT_RESET_SECOND_FACTOR.key] },
  };

  readonly #logger = new Logger('ResetAgentSecondFactor');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResetAgentSecondFactorDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ResetAgentSecondFactorInput,
  ): Promise<Result<ResetAgentSecondFactorOutput, ResetAgentSecondFactorFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ResetAgentSecondFactorOutput, ResetAgentSecondFactorFailure>> => {
        const now = this.deps.clock.now();
        if (!(await this.deps.accounts.lockCredential(market, input.accountId))) {
          return err({ code: 'account.unknown' });
        }
        if ((await readActingGrants(this.deps, market, self, [], RULE_KEYS)) === null) {
          return err({ code: 'access.denied' });
        }
        const account = await this.deps.accounts.findById(market, input.accountId);
        if (account === null || account.state.population !== 'agent') {
          return err({ code: 'account.unknown' });
        }
        const accountId = account.state.id;
        const factor = await this.deps.factors.findByAccount(market, accountId);
        if (factor === null) return err({ code: 'second-factor.none' });
        const before = factor.state.state;
        factor.recordReset(now);
        await this.deps.factors.removeOf(market, accountId);
        const revokedSessions = await this.deps.sessions.revokeAllOf(
          market,
          accountId,
          'second-factor-reset',
          now,
          null,
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
        return ok({ code: 'second-factor.reset', accountId, revokedSessions });
      },
      { isolation: 'serializable' },
    );
    this.#logger.log({
      msg: 'identity.reset-agent-second-factor',
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      ...(result.ok ? { revokedSessions: result.value.revokedSessions } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
