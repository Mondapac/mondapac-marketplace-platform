import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { InvitationIssuedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import {
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../ports/invitation.repository';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/seller-team.repository';

export interface IssueSecondAdminInvitationInput {
  /** The second admin's address, typed by the operator. Personal data: never logged. */
  readonly email: string;
}

export interface IssueSecondAdminInvitationOutput {
  readonly code: 'invitation.issued';
  readonly invitationId: Id<'Invitation'>;
}

export type IssueSecondAdminInvitationFailure =
  | { readonly code: 'validation.failed' }
  /** The Market has no admin account yet: the first-admin routine comes first. */
  | { readonly code: 'second-admin.no-first-admin' }
  /**
   * The Market has more than one admin account, or its one admin is not an active holder of the
   * Platform Administrator role: the bootstrap is over, admins invite through the panel.
   */
  | { readonly code: 'second-admin.not-bootstrap' }
  /** The role seed has not run in this Market: the Platform Administrator role is missing. */
  | { readonly code: 'roles.not-seeded' }
  /** The Market already has a pending admin invitation (any address, expired ones included). */
  | { readonly code: 'invitation.already-pending' }
  /** The Market configures no admin invitation lifetime: nothing could be dispatched. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface IssueSecondAdminInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly invitations: InvitationRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The operator's `second-admin` routine (owner decision 22 Nov 2026, operational test data,
 * phase 2): the bootstrap of a Market's second admin. Inviting an admin is a `people` change, and
 * where people is reviewed (the default) the invitation waits for another admin's approval
 * (System requests, maker-checker: the author never approves their own). A Market with one admin
 * has nobody to approve, so it could never add a second one, and every change that waits for
 * approval stayed stuck. This routine closes that gap once.
 *
 * Rule `system`: the command runs it as the Market's `SYSTEM` actor after it has written the
 * operator's line to the external log (`platform-audit.md` 9.2), as `first-admin` does. In one
 * SERIALIZABLE unit (the rule spans rows):
 * - the Market has exactly one admin account (`second-admin.no-first-admin` with none,
 *   `second-admin.not-bootstrap` with more), and it is active and an active holder of the
 *   Platform Administrator role (else `second-admin.not-bootstrap`);
 * - the Market has no pending admin invitation at all, expired ones included
 *   (`invitation.already-pending`), so the routine never issues two: once one is accepted the
 *   Market has two admins and the routine is closed for good.
 *   A panel invitation the one admin sends at the same instant runs at the default isolation
 *   and may still commit beside this one (Hassan, PR #1230 finding 1); it is then held for
 *   another admin's approval like any panel invitation, so maker-checker still holds.
 * Then an `admin` invitation for the Platform Administrator role is issued with the one admin as
 * its inviter, so its acceptance re-checks a live inviter who may still grant the role (slice
 * 8b, `inviterStillStands`) like any panel invitation, and never takes the first-admin path
 * (an invitation without an inviter; Hassan L3: never a second first admin). It is not filed as
 * a System request: the operator, who already holds the server, is the second pair of eyes. The
 * unit records `identity.invitation-issued.v1` (the mail handler mints the token and dispatches
 * it) and writes `identity.invitation.issued` as `SYSTEM` with `via: operator.second-admin`, so
 * the trail shows the named inviter did not act. The address is never logged or audited.
 */
export class IssueSecondAdminInvitation extends UseCase<
  IssueSecondAdminInvitationInput,
  IssueSecondAdminInvitationOutput,
  IssueSecondAdminInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.issue-second-admin-invitation',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('IssueSecondAdminInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssueSecondAdminInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssueSecondAdminInvitationInput,
  ): Promise<Result<IssueSecondAdminInvitationOutput, IssueSecondAdminInvitationFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const email = parseEmailAddress(input.email);
    if (!email.ok) return err({ code: 'validation.failed' });
    const lifetime = this.deps.policy.invitationLifetimeMinutes(market, 'admin');
    if (lifetime === null) return err({ code: 'access.unavailable' });

    let result: Result<IssueSecondAdminInvitationOutput, IssueSecondAdminInvitationFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<IssueSecondAdminInvitationOutput, IssueSecondAdminInvitationFailure>
        > => {
          const role = await this.deps.roles.findSystemRole(market, 'platform');
          if (role === null) return err({ code: 'roles.not-seeded' });
          const admins = await this.deps.accounts.firstInPopulation(market, 'admin', 2);
          if (admins.length === 0) return err({ code: 'second-admin.no-first-admin' });
          const [sole] = admins;
          if (admins.length > 1 || sole!.status !== 'active') {
            return err({ code: 'second-admin.not-bootstrap' });
          }
          // The one admin must itself hold the role now (Hassan, PR #1230 finding 3).
          const holders = await this.deps.assignments.activeHoldersOf(market, role.state.id);
          if (!holders.includes(sole!.id)) {
            return err({ code: 'second-admin.not-bootstrap' });
          }
          if ((await this.deps.invitations.pendingAdminInvitations(market, null, 1)).length > 0) {
            return err({ code: 'invitation.already-pending' });
          }
          const invitation = Invitation.issue({
            id: this.deps.ids.next<'Invitation'>(),
            marketId: market.marketId,
            kind: 'admin',
            email: email.value,
            roleId: role.state.id,
            sellerId: null,
            invitedByAccountId: sole!.id,
            now: this.deps.clock.now(),
          });
          await this.deps.invitations.add(market, invitation);
          await this.deps.outbox.append(context, invitation.pendingEvents);
          await this.deps.audit.record(
            context,
            InvitationIssuedAudit.entry(invitation.state.id, {
              after: { kind: 'admin', roleId: role.state.id, via: 'operator.second-admin' },
            }),
          );
          return ok({ code: 'invitation.issued', invitationId: invitation.state.id });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      if (error instanceof InvitationAlreadyPendingError) {
        result = err({ code: 'invitation.already-pending' });
      } else {
        throw error;
      }
    }
    this.#logger.log({
      msg: 'identity.second-admin.invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok ? { invitationId: result.value.invitationId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
