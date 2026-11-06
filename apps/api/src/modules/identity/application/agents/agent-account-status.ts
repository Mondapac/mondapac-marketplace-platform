import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { AccountDisabledAudit, AccountEnabledAudit } from '../../domain/audit';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import {
  actingAgentManager,
  revokeAgentInvitation,
  type AgentInvitationDependencies,
} from './agent-invitations';

export interface AgentAccountStatusInput {
  /** The agent account id: the one `issueAgentInvitation` returned. */
  readonly accountId: Id<'Account'>;
}

export interface AgentAccountStatusOutput {
  readonly code: 'agent.disabled' | 'agent.enabled';
  readonly accountId: Id<'Account'>;
  /** Sessions revoked by a disable (0 for an enable). */
  readonly revokedSessions: number;
  /** Open invitations voided by a disable (0 for an enable). */
  readonly voidedInvitations: number;
}

export type AgentAccountStatusFailure =
  /** No agent account or open invitation with this id in the Market: "not found". */
  { readonly code: 'agent.unknown' } | { readonly code: 'access.denied' };

export interface AgentAccountStatusDependencies extends Pick<
  AgentInvitationDependencies,
  | 'unitOfWork'
  | 'accounts'
  | 'invitations'
  | 'grants'
  | 'effectiveKeys'
  | 'outbox'
  | 'audit'
  | 'clock'
> {
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
}

const logger = new Logger('AgentAccountStatus');

/**
 * Disabling and enabling an agent account (ADR-0045 decision 5), the routine of
 * `identity.disable-agent-account` and `identity.enable-agent-account`. In **one serializable
 * unit** (every writer of `accounts.status`, HF8): the acting admin re-checked for `agents.agent.manage`,
 * the credential lock (the one a sign-in's closing unit takes, so a sign-in racing a disable
 * either commits its session first and is revoked here, or reads the disabled status and
 * refuses), then
 *
 * - disable: the agent's open invitation voided (revoked, its handover code cleared), the account
 *   disabled, **every session revoked** and every open challenge void; an agent still only
 *   invited (no account yet) just has its invitation voided;
 * - enable: the account active again; sessions and invitations are not brought back.
 *
 * Both are idempotent (the `agents` module retries a half-done disable): an account already in
 * the target state answers the same success. An account of another population, or an id that is
 * neither an agent account nor a reserved agent id, is `agent.unknown`, byte-identical to a
 * missing one. No self-protection or last-holder rule applies: an agent holds no role.
 */
export async function changeAgentAccountStatus(
  deps: AgentAccountStatusDependencies,
  context: CallContext,
  input: AgentAccountStatusInput,
  to: 'disabled' | 'active',
): Promise<Result<AgentAccountStatusOutput, AgentAccountStatusFailure>> {
  const { market } = context;
  const result = await deps.unitOfWork.run(
    market,
    async (): Promise<Result<AgentAccountStatusOutput, AgentAccountStatusFailure>> => {
      const now = deps.clock.now();
      if (!(await actingAgentManager(deps, context))) return err({ code: 'access.denied' });
      const locked = await deps.accounts.lockCredential(market, input.accountId);
      const account = locked ? await deps.accounts.findById(market, input.accountId) : null;
      const agent = account !== null && account.state.population === 'agent' ? account : null;
      let voidedInvitations = 0;
      if (to === 'disabled') {
        const open = await deps.invitations.findPendingAgentByAccountId(market, input.accountId);
        if (open !== null && (await revokeAgentInvitation(deps, context, open))) {
          voidedInvitations = 1;
        }
      }
      if (agent === null) {
        // Only an agent that was invited and never accepted can be "disabled" without an account.
        return voidedInvitations === 1 && to === 'disabled'
          ? ok({
              code: 'agent.disabled',
              accountId: input.accountId,
              revokedSessions: 0,
              voidedInvitations,
            })
          : err({ code: 'agent.unknown' });
      }
      const accountId = agent.state.id;
      const before = agent.state.status;
      let revokedSessions = 0;
      if (before !== to) {
        const changed = to === 'disabled' ? agent.disable(now) : agent.enable(now);
        if (!changed.ok) return err({ code: 'agent.unknown' });
        await deps.accounts.save(market, agent);
        await deps.outbox.append(context, agent.pendingEvents);
        const definition = to === 'disabled' ? AccountDisabledAudit : AccountEnabledAudit;
        await deps.audit.record(
          context,
          definition.entry(accountId, {
            before: { status: before },
            after: { status: to, population: 'agent' },
          }),
        );
      }
      if (to === 'disabled') {
        // Also for an account that was already disabled: a retry finishes what a failed one left.
        revokedSessions = await deps.sessions.revokeAllOf(
          market,
          accountId,
          'account-disabled',
          now,
          null,
        );
        await deps.challenges.voidAllOf(market, accountId);
      }
      return ok({
        code: to === 'disabled' ? 'agent.disabled' : 'agent.enabled',
        accountId,
        revokedSessions,
        voidedInvitations,
      });
    },
    { isolation: 'serializable' },
  );
  logger.log({
    msg: `identity.${to === 'disabled' ? 'disable' : 'enable'}-agent-account`,
    outcome: result.ok ? result.value.code : result.error.code,
    accountId: input.accountId,
    ...(result.ok
      ? {
          revokedSessions: result.value.revokedSessions,
          voidedInvitations: result.value.voidedInvitations,
        }
      : {}),
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}
