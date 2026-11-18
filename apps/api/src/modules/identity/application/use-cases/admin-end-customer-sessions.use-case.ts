import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import { AccountSessionsEndedForErasureAudit } from '../../domain/audit';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';
import { endEveryCustomerSession } from '../accounts/customer-security';

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

/** The protected key of customers' `buyer-account.delete`; only the declaring module can brand it, so it is cast here. */
const DELETION_KEY = 'customers.buyer-account.delete' as PermissionKey;

/**
 * `identity.admin-end-customer-sessions`: ends every session of a customer account because an
 * admin asked for the account's deletion (customers package 5c), as `end-all-customer-sessions`
 * does for the job. Rule `permissions [customers.buyer-account.delete]` (protected): the actor must be a platform admin and not an acting-as
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
    // The key is customers' (package 5c, Hassan M1): only a caller that may delete a buyer's account
    // reads this; the key is customers' (a contract test pins it to the declaration).
    rule: { kind: 'permissions', allOf: [DELETION_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminEndCustomerSessionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminEndCustomerSessionsInput,
  ): Promise<Result<AdminEndCustomerSessionsOutput, AdminEndCustomerSessionsFailure>> {
    if (!isPlatformAdminActor(context.actor)) {
      return err({ code: 'access.denied' });
    }
    // The shared core of "sign out everywhere" (customers phase 2b), with this request's reason
    // and audit row; an account that is gone or is not a customer's ends nothing.
    const revokedSessions = await endEveryCustomerSession(
      this.deps,
      context,
      input.accountId,
      'account-erasure',
      (revoked) =>
        AccountSessionsEndedForErasureAudit.entry(input.accountId, {
          after: { requestId: input.requestId, revokedSessions: revoked },
        }),
    );
    return ok({ code: 'sessions-ended', revokedSessions: revokedSessions ?? 0 });
  }
}
