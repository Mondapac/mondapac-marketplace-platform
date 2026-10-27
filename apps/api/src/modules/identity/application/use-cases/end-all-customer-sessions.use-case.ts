import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AccountSessionsEndedForErasureAudit } from '../../domain/audit';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';

export interface EndAllCustomerSessionsInput {
  readonly accountId: Id<'Account'>;
  /** The customers deletion request that asked; recorded in the audit row. */
  readonly requestId: Id<'AccountDeletionRequest'>;
}

export interface EndAllCustomerSessionsOutput {
  readonly code: 'sessions-ended';
  /** How many sessions were ended; 0 when none was open or the account is already gone. */
  readonly revokedSessions: number;
}

export type EndAllCustomerSessionsFailure = never;

export interface EndAllCustomerSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `identity.end-all-customer-sessions`: ends every session of a customer account, the calling
 * one included (customers package 5b: the deletion job locks the buyer out before its last
 * blocker check, so nothing can be ordered between that check and the erasure). Rule `system`.
 * One unit that takes the account's credential lock first, as every session revocation does, so
 * a sign-in racing it either commits and is ended here or opens afterwards. An account that is
 * already gone ends nothing. No mail. The audit row
 * `identity.account.sessions-ended-for-erasure` names the account id, the deletion request id and the
 * count. Not exposed over HTTP.
 */
export class EndAllCustomerSessions extends UseCase<
  EndAllCustomerSessionsInput,
  EndAllCustomerSessionsOutput,
  EndAllCustomerSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.end-all-customer-sessions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EndAllCustomerSessionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: EndAllCustomerSessionsInput,
  ): Promise<Result<EndAllCustomerSessionsOutput, EndAllCustomerSessionsFailure>> {
    const { market } = context;
    const { unitOfWork, accounts, sessions, audit, clock } = this.deps;
    return unitOfWork.run(
      market,
      async (): Promise<Result<EndAllCustomerSessionsOutput, EndAllCustomerSessionsFailure>> => {
        if (!(await accounts.lockCredential(market, input.accountId))) {
          return ok({ code: 'sessions-ended', revokedSessions: 0 });
        }
        const account = await accounts.findById(market, input.accountId);
        // Only a customer account: another population's sessions are never ended by this call.
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
