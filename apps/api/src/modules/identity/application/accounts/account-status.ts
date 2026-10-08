import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { AccountDisabledAudit, AccountEnabledAudit } from '../../domain/audit';
import { GrantPolicy } from '../../domain/grant-policy';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { readGrants, type GrantSubject } from '../roles/granting';

/** The account an admin disables or enables again. */
export interface AccountStatusInput {
  readonly accountId: Id<'Account'>;
}

export interface AccountStatusOutput {
  readonly code: 'account.disabled' | 'account.enabled';
  readonly accountId: Id<'Account'>;
  /** Sessions revoked by a disable (0 for an enable). */
  readonly revokedSessions: number;
}

export type AccountStatusFailure =
  /** No account of this population with this id in the Market: "not found" (5.2). */
  | { readonly code: 'account.unknown' }
  | { readonly code: 'account.already-disabled' }
  | { readonly code: 'account.already-active' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'member.last-holder' }
  | { readonly code: 'access.denied' };

export interface AccountStatusDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const logger = new Logger('AccountStatus');

/**
 * Disabling and enabling an admin or a customer account (identity design 3.1; AC 11, AC 18; R1,
 * R3; slice 8b), the one routine of the four use cases (`identity.disable-admin-account`,
 * `.enable-admin-account`, `.disable-customer-account`, `.enable-customer-account`), each with its
 * own permission. In **one serializable unit** (5.5, HF8: every writer of `accounts.status`):
 *
 * 1. The account's credential lock first (`AccountRepository.lockCredential`), the lock the
 *    sign-in closing units take before they re-check the status (6.3, HF11), so a sign-in racing
 *    a disable either commits its session first, and the session is revoked here, or reads the
 *    disabled status and refuses. Then the account: one of the use case's population in the
 *    context Market, else `account.unknown`, byte-identical to a missing one (5.2).
 * 2. The grants of the actor and the target, read in this unit (Hassan I-2); `GrantPolicy.canActOn`:
 *    never oneself (`member.self`), and an admin target's keys are a subset of the actor's (R1).
 *    Across scopes (a customer) the platform permission alone decides (Ali 14.1-2). Acting on a
 *    holder of the Platform Administrator role needs that role (R3).
 * 3. Disable only: `LastHolderPolicy` on the Platform Administrator role (`member.last-holder`,
 *    AC 25), counted in this unit.
 * 4. The account's status under its version; for a disable, **every session revoked**
 *    (`account-disabled`) and **every open challenge void** (HF11), so no session survives and
 *    none can be completed. The event (`account-disabled` or `account-enabled`) and the audit
 *    row (`identity.account.disabled` or `.enabled`, state codes only).
 *
 * SEL-08 (identity design 6.7, Hassan I2 (c), PR #162): Login-as-Seller does not exist yet. When
 * it lands, disabling an admin must also end that admin's acting-as sessions in this unit
 * (admin-side trigger), and disabling a Seller Owner is not this path (3.1).
 */
export async function changeAccountStatus(
  deps: AccountStatusDependencies,
  context: CallContext,
  input: AccountStatusInput,
  change: { readonly population: 'admin' | 'customer'; readonly to: 'disabled' | 'active' },
): Promise<Result<AccountStatusOutput, AccountStatusFailure>> {
  const { market, actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
  const result = await deps.unitOfWork.run(
    market,
    async (): Promise<Result<AccountStatusOutput, AccountStatusFailure>> => {
      const now = deps.clock.now();
      if (!(await deps.accounts.lockCredential(market, input.accountId))) {
        return err({ code: 'account.unknown' });
      }
      const account = await deps.accounts.findById(market, input.accountId);
      if (account === null || account.state.population !== change.population) {
        return err({ code: 'account.unknown' });
      }
      const accountId = account.state.id;
      const subject: GrantSubject = { accountId, population: change.population, sellerId: null };
      const reading = await readGrants(deps.grants, deps.effectiveKeys, market, self, [subject]);
      if (reading === null) return err({ code: 'access.denied' });
      const acted = GrantPolicy.canActOn(reading.actor, reading.targets.get(accountId)!);
      if (!acted.ok) return err(acted.error);
      if (change.population === 'admin') {
        const system = await deps.roles.findSystemRole(market, 'platform');
        const assignment = await deps.assignments.findByAccount(market, accountId);
        const holdsSystem = system !== null && assignment?.state.roleId === system.state.id;
        if (
          holdsSystem &&
          !(reading.actor.holdsSystemRole && reading.actor.roleId === system.state.id)
        ) {
          return err({ code: 'member.outranks-actor' });
        }
        if (holdsSystem && change.to === 'disabled') {
          const holders = await deps.assignments.activeHoldersOf(market, system.state.id);
          const kept = LastHolderPolicy.allowsLosing(holders, accountId);
          if (!kept.ok) return err(kept.error);
        }
      }
      const changed = change.to === 'disabled' ? account.disable(now) : account.enable(now);
      if (!changed.ok) {
        // A seller-side account never reaches here (population checked above).
        return changed.error.code === 'account.not-eligible'
          ? err({ code: 'account.unknown' })
          : err(changed.error);
      }
      await deps.accounts.save(market, account);
      let revokedSessions = 0;
      if (change.to === 'disabled') {
        revokedSessions = await deps.sessions.revokeAllOf(
          market,
          accountId,
          'account-disabled',
          now,
          null,
        );
        await deps.challenges.voidAllOf(market, accountId);
      }
      await deps.outbox.append(context, account.pendingEvents);
      const definition = change.to === 'disabled' ? AccountDisabledAudit : AccountEnabledAudit;
      await deps.audit.record(
        context,
        definition.entry(accountId, {
          before: { status: change.to === 'disabled' ? 'active' : 'disabled' },
          after: { status: change.to, population: change.population },
        }),
      );
      return ok({
        code: change.to === 'disabled' ? 'account.disabled' : 'account.enabled',
        accountId,
        revokedSessions,
      });
    },
    { isolation: 'serializable' },
  );
  logger.log({
    msg: `identity.${change.to === 'disabled' ? 'disable' : 'enable'}-${change.population}-account`,
    outcome: result.ok ? result.value.code : result.error.code,
    accountId: input.accountId,
    ...(result.ok ? { revokedSessions: result.value.revokedSessions } : {}),
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}
