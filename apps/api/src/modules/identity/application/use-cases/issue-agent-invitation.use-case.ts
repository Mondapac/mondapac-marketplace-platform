import { Logger } from '@nestjs/common';
import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseDisplayName } from '../../domain/display-name';
import { parseEmailAddress } from '../../domain/email-address';
import { InvitationAlreadyPendingError } from '../ports/invitation.repository';
import {
  actingAgentManager,
  issueAgentInvitation,
  type AgentInvitationDependencies,
} from '../agents/agent-invitations';
import type { FieldProblem } from './register-customer.use-case';

export interface IssueAgentInvitationInput {
  /** The invitee's address. Personal data: never logged or audited. */
  readonly email: string;
  /** The name the agent account will carry (the account is created with it at acceptance). */
  readonly displayName: string;
}

export interface IssueAgentInvitationOutput {
  readonly code: 'invitation.issued';
  /** The id the agent account will have: the `agents` module keys its profile by it. */
  readonly accountId: Id<'Account'>;
  readonly invitationId: Id<'Invitation'>;
  /** Shown once. Only its HMAC is stored: a lost code means revoke and reissue. */
  readonly handoverCode: string;
}

export type IssueAgentInvitationFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** An agent account or a live invitation for the address exists: to the admin only. */
  | { readonly code: 'invitation.already-pending' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  /** The Market configures no agent invitation lifetime. */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

/**
 * Issues an agent invitation with a handover code (ADR-0045 decision 2; agents design 3). Called
 * through the facade by the `agents` module's CreateAgent, which has already checked `agents.manage`;
 * identity checks it again on the same actor in the unit that writes (the key is `agents`'s, passed
 * through the caller's actor). Rule `own-resources` (an active admin), then in one unit: the acting
 * admin re-checked, the address not taken, the `mail.account` counter, a stale pending invitation
 * replaced, the invitation stored without a token (`identity.invitation-issued.v1`: the mail
 * handler mints the link token), and `identity.agent-invitation.issued` as the inviter. The
 * handover code is returned here once; only its HMAC is stored. The address, the name and the code
 * are never logged.
 */
export class IssueAgentInvitation extends UseCase<
  IssueAgentInvitationInput,
  IssueAgentInvitationOutput,
  IssueAgentInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.issue-agent-invitation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('IssueAgentInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AgentInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssueAgentInvitationInput,
  ): Promise<Result<IssueAgentInvitationOutput, IssueAgentInvitationFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fields: FieldProblem[] = [];
    const email = parseEmailAddress(typeof input.email === 'string' ? input.email : '');
    if (!email.ok) fields.push({ path: 'email', code: 'format' });
    const name = parseDisplayName(typeof input.displayName === 'string' ? input.displayName : '');
    if (!name.ok) fields.push({ path: 'displayName', code: name.error.rule });
    if (!email.ok || !name.ok) return err({ code: 'validation.failed', fields });
    const lifetimeMinutes = this.deps.policy.invitationLifetimeMinutes(market, 'agent');
    if (lifetimeMinutes === null) return err({ code: 'access.unavailable' });

    let result: Result<IssueAgentInvitationOutput, IssueAgentInvitationFailure>;
    try {
      result = await this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<IssueAgentInvitationOutput, IssueAgentInvitationFailure>> => {
          if (!(await actingAgentManager(this.deps, context))) {
            return err({ code: 'access.denied' });
          }
          const issued = await issueAgentInvitation(this.deps, context, {
            email: email.value,
            displayName: name.value,
            lifetimeMinutes,
          });
          return issued.ok
            ? { ok: true, value: { code: 'invitation.issued', ...issued.value } }
            : issued;
        },
      );
    } catch (error) {
      if (!(error instanceof InvitationAlreadyPendingError)) throw error;
      result = err({ code: 'invitation.already-pending' });
    }
    // Ids and codes only: never the address, the name or the handover code.
    this.#logger.log({
      msg: 'identity.issue-agent-invitation',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok ? { invitationId: result.value.invitationId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
