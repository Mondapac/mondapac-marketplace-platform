import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AccountSessionsEndedForErasureAudit } from '../../domain/audit';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';
import { isActingAsSession } from '../sellers/access-decision-reads';

export interface AdminEndCustomerSessionsInput {
  readonly accountId: Id<'Account'>;
  /** The deletion request an admin made; recorded in the audit row. */
  readonly requestId: Id<'AccountDeletionRequest'>;
}

export interface AdminEndCustomerSessionsOutput {
  readonly code: 'sessions-ended';
  readonly revokedSessions: number;
}

export type AdminEndCustomerSessionsFailure = { readonly code: 'access.denied' };

export interface AdminEndCustomerSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `identity.admin-end-customer-sessions`: ends every session of a customer account because an
 * admin asked for the account's deletion (customers package 5c), as `end-all-customer-sessions`
 * does for the job. Rule `own-resources`: the actor must be a platform admin and not an acting-as
 * session, checked here; the calling use case has already passed its own permission gate and the
 * account's Market check. One unit that takes the account's credential lock first. Only a customer
 * account's sessions are ever ended. No mail. Audited with the request id (the admin is the audit
 * row's actor). Not exposed over HTTP.
 */
export class AdminEndCustomerSessions extends UseCase<
  AdminEndCustomerSessionsInput,
  AdminEndCustomerSessionsOutput,
  AdminEndCustomerSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-end-customer-sessions',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminEndCustomerSessionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AdminEndCustomerSessionsInput,
  ): Promise<Result<AdminEndCustomerSessionsOutput, AdminEndCustomerSessionsFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    const { unitOfWork, accounts, sessions, audit, clock } = this.deps;
    return unitOfWork.run(
      market,
      async (): Promise<
        Result<AdminEndCustomerSessionsOutput, AdminEndCustomerSessionsFailure>
      > => {
        if (!(await accounts.lockCredential(market, input.accountId))) {
          return ok({ code: 'sessions-ended', revokedSessions: 0 });
        }
        const account = await accounts.findById(market, input.accountId);
        if (account === null || account.state.population !== 'customer') {
          return ok({ code: 'sessions-ended', revokedSessions: 0 });
        }
        const revokedSessions = await sessions.revokeAllOf(
          market,
          input.accountId,
          'account-erasure',
          clock.now(),
          null,
        );
        await audit.record(
          context,
          AccountSessionsEndedForErasureAudit.entry(input.accountId, {
            after: { requestId: input.requestId, revokedSessions },
          }),
        );
        return ok({ code: 'sessions-ended', revokedSessions });
      },
    );
  }
}
