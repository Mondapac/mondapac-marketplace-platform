import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { AGENTS_MANAGE_KEY, AGENTS_READ_KEY, type AgentAccess } from '../../contracts/agent-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import { readActingGrants } from '../roles/granting';

/** At most this many ids per call: one query for the accounts, one for the invitations. */
export const AGENT_ACCESS_BATCH_LIMIT = 500;

export interface AgentAccessOfInput {
  readonly accountIds: readonly Id<'Account'>[];
}

export type AgentAccessOfFailure =
  { readonly code: 'validation.failed' } | { readonly code: 'access.denied' };

export interface AgentAccessOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

/**
 * `agentAccessOf` (ADR-0045 decision 5): the access state of agents, read live from committed
 * rows and never from an event: `active` or `disabled` for an agent account, `invited` for an id
 * with a pending invitation and no account (an expired one not yet purged included). An id that is
 * neither is absent from the answer, as is an account of another population. Rule `own-resources`
 * for an active admin who holds `agents.read` or `agents.manage` (both are the `agents` module's
 * keys, re-checked on the caller's actor in the read unit). Read-only: opens no transaction beyond
 * the unit's snapshot (ADR-0025).
 */
export class AgentAccessOf extends UseCase<
  AgentAccessOfInput,
  ReadonlyMap<Id<'Account'>, AgentAccess>,
  AgentAccessOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.agent-access-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AgentAccessOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AgentAccessOfInput,
  ): Promise<Result<ReadonlyMap<Id<'Account'>, AgentAccess>, AgentAccessOfFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = [...new Set(input.accountIds)];
    if (!Array.isArray(input.accountIds) || ids.length > AGENT_ACCESS_BATCH_LIMIT) {
      return err({ code: 'validation.failed' });
    }
    const self = { accountId: actor.accountId, population: 'admin', sellerId: null } as const;
    const read = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ReadonlyMap<Id<'Account'>, AgentAccess>, AgentAccessOfFailure>> => {
        const allowed =
          (await readActingGrants(this.deps, market, self, [], [AGENTS_READ_KEY])) !== null ||
          (await readActingGrants(this.deps, market, self, [], [AGENTS_MANAGE_KEY])) !== null;
        if (!allowed) return err({ code: 'access.denied' });
        const statuses = await this.deps.accounts.agentStatuses(market, ids);
        const states = new Map<Id<'Account'>, AgentAccess>(statuses);
        const unknown = ids.filter((id) => !statuses.has(id));
        // An id with an account of another population is not an agent: its pending-invitation
        // lookup finds nothing, because only agent invitations reserve an id.
        for (const id of await this.deps.invitations.agentAccountIdsWithPendingInvitation(
          market,
          unknown,
        )) {
          states.set(id, 'invited');
        }
        return ok(states);
      },
      { readOnly: true },
    );
    return read;
  }
}
