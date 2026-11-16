import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SystemRequestRecorder } from '../../../../platform/change-review/change-review';
import type { Account, AccountStatusRefused } from '../../domain/account';
import { AccountDisabledAudit, AccountEnabledAudit } from '../../domain/audit';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import {
  ADMIN_STATUS_SUBJECT_KIND,
  openPeopleReview,
  type ReviewRef,
} from '../people/people-review';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { statusChangeVerdict } from './admin-verdicts';

/** The account an admin disables or enables again. */
export interface AccountStatusInput {
  readonly accountId: Id<'Account'>;
  /**
   * The admin's note for the reviewer (Admin Inbox › System requests, area people): needed only
   * when an admin is enabled in a Market that reviews the area. Ignored by every other change.
   */
  readonly note?: unknown;
}

export interface AccountStatusOutput {
  readonly code: 'account.disabled' | 'account.enabled';
  readonly accountId: Id<'Account'>;
  /** Sessions revoked by a disable (0 for an enable). */
  readonly revokedSessions: number;
  /** The review an admin's enabling opened; null otherwise (a disable never opens one). */
  readonly request: ReviewRef | null;
}

export type AccountStatusFailure =
  /** No account of this population with this id in the Market: "not found" (5.2). */
  | { readonly code: 'account.unknown' }
  | { readonly code: 'account.already-disabled' }
  | { readonly code: 'account.already-active' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'member.last-holder' }
  /** The note is missing or too long where the enabling is reviewed (path `note`). */
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
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

/** The ports of an admin's enabling, which opens its review (area people). */
export interface AdminEnableDependencies extends AccountStatusDependencies {
  readonly review: SystemRequestRecorder;
}

const logger = new Logger('AccountStatus');

/**
 * Writes a status change of a read account in the caller's open serializable unit, the one write
 * of `changeAccountStatus` and of a reviewer's revert of an enabling: the status under its
 * version; for a disable, **every session revoked** (`account-disabled`) and **every open
 * challenge void** (HF11); the event. The caller holds the credential lock and has checked the
 * guards; the account's own refusal when it cannot take the status.
 */
export async function writeAccountStatus(
  deps: Pick<AccountStatusDependencies, 'accounts' | 'sessions' | 'challenges' | 'outbox'>,
  context: CallContext,
  account: Account,
  to: 'disabled' | 'active',
  now: Temporal.Instant,
): Promise<Result<{ readonly revokedSessions: number }, AccountStatusRefused>> {
  const changed = to === 'disabled' ? account.disable(now) : account.enable(now);
  if (!changed.ok) return err(changed.error);
  const { market } = context;
  await deps.accounts.save(market, account);
  let revokedSessions = 0;
  if (to === 'disabled') {
    revokedSessions = await deps.sessions.revokeAllOf(
      market,
      account.state.id,
      'account-disabled',
      now,
      null,
    );
    await deps.challenges.voidAllOf(market, account.state.id);
  }
  await deps.outbox.append(context, account.pendingEvents);
  return ok({ revokedSessions });
}

/**
 * Disabling and enabling an admin or a customer account (identity design 3.1; AC 11, AC 18; R1,
 * R3; slice 8b), the one routine of the four use cases (`identity.disable-admin-account`,
 * `.enable-admin-account`, `.disable-customer-account`, `.enable-customer-account`), each with its
 * own permission. In **one serializable unit** (5.5, HF8: every writer of `accounts.status`):
 *
 * 1. The account's credential lock first (`AccountRepository.lockCredential`), the lock the
 *    sign-in closing units take before they re-check the status (6.3, HF11), so a sign-in racing
 *    a disable either commits its session first, and the session is revoked here, or reads the
 *    disabled status and refuses. Then the actor, read in this unit (`readActingGrants`;
 *    Mohammad C1, Hassan I1 on PR #187): still an active, verified admin holding the rule's
 *    key, else `access.denied`. Then the account: one of the use case's population in the
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
  change: {
    readonly population: 'admin' | 'customer';
    readonly to: 'disabled' | 'active';
    /** The key of the calling use case's rule, re-checked in the unit (C1). */
    readonly ruleKey: string;
    /** An admin's enabling opens its review here (area people); nothing else does. */
    readonly review?: SystemRequestRecorder;
  },
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
      const subject: GrantSubject = {
        accountId: input.accountId,
        population: change.population,
        sellerId: null,
      };
      // C1: the actor is still an active admin holding the rule's key, read in this unit.
      const reading = await readActingGrants(deps, market, self, [subject], [change.ruleKey]);
      if (reading === null) return err({ code: 'access.denied' });
      const account = await deps.accounts.findById(market, input.accountId);
      if (account === null || account.state.population !== change.population) {
        return err({ code: 'account.unknown' });
      }
      const accountId = account.state.id;
      let targetRoleId: Id<'Role'> | null = null;
      let systemRoleId: Id<'Role'> | null = null;
      if (change.population === 'admin') {
        systemRoleId = (await deps.roles.findSystemRole(market, 'platform'))?.state.id ?? null;
        targetRoleId =
          (await deps.assignments.findByAccount(market, accountId))?.state.roleId ?? null;
      }
      // The one verdict of the command and of the admin team list's hint (slice 8c).
      const verdict = await statusChangeVerdict({
        actor: reading.actor,
        target: reading.targets.get(accountId)!,
        population: account.state.population,
        status: account.state.status,
        to: change.to,
        targetRoleId,
        systemRoleId,
        holders: () => deps.assignments.activeHoldersOf(market, systemRoleId!),
      });
      if (!verdict.ok) return err(verdict.error);
      const written = await writeAccountStatus(deps, context, account, change.to, now);
      if (!written.ok) {
        // A seller-side account never reaches here (population checked above).
        return written.error.code === 'account.not-eligible'
          ? err({ code: 'account.unknown' })
          : err(written.error);
      }
      const definition = change.to === 'disabled' ? AccountDisabledAudit : AccountEnabledAudit;
      await deps.audit.record(
        context,
        definition.entry(accountId, {
          before: { status: change.to === 'disabled' ? 'active' : 'disabled' },
          after: { status: change.to, population: change.population },
        }),
      );
      let request: ReviewRef | null = null;
      if (change.review !== undefined && change.population === 'admin' && change.to === 'active') {
        // The enabling is live; its review opens in the same unit (a refusal rolls it back).
        const opened = await openPeopleReview(change.review, context, {
          subjectKind: ADMIN_STATUS_SUBJECT_KIND,
          subjectRef: accountId,
          before: { status: 'disabled' },
          after: { status: 'active' },
          note: input.note,
        });
        if (!opened.ok) return err(opened.error);
        request = opened.value;
      }
      return ok({
        code: change.to === 'disabled' ? 'account.disabled' : 'account.enabled',
        accountId,
        revokedSessions: written.value.revokedSessions,
        request,
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
