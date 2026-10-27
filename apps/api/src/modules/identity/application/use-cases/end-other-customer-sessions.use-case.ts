import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { OtherSessionsSignedOutAudit } from '../../domain/audit';
import { sessionIsLive } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';

export interface EndOtherCustomerSessionsOutput {
  readonly code: 'other-sessions-ended';
  /** How many sessions were ended; 0 when the caller's was the only one. */
  readonly revokedSessions: number;
}

export type EndOtherCustomerSessionsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'session.invalid' };

export interface EndOtherCustomerSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `identity.end-other-customer-sessions`: ends every session of the calling customer's own
 * account except the one the request was made with (customers package 5b: a deletion request
 * leaves only the session that asked, which can cancel it). Rule `own-resources`, customers only.
 * One unit that takes the account's credential lock first, as every session revocation does, so
 * a sign-in racing it either commits and is ended here or opens afterwards. No throttle and no
 * mail: the customer's own action, and the calling module records its own audit row. The audit
 * row reuses `identity.account.other-sessions-signed-out` (count and kept session id only).
 */
export class EndOtherCustomerSessions extends UseCase<
  Record<string, never>,
  EndOtherCustomerSessionsOutput,
  EndOtherCustomerSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.end-other-customer-sessions',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EndOtherCustomerSessionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<EndOtherCustomerSessionsOutput, EndOtherCustomerSessionsFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    const { unitOfWork, accounts, sessions, audit, clock } = this.deps;
    return unitOfWork.run(
      market,
      async (): Promise<
        Result<EndOtherCustomerSessionsOutput, EndOtherCustomerSessionsFailure>
      > => {
        const now = clock.now();
        if (!(await accounts.lockCredential(market, actor.accountId))) {
          return err({ code: 'session.invalid' });
        }
        const current = await sessions.findById(market, actor.sessionId);
        if (
          current === null ||
          current.accountId !== actor.accountId ||
          !sessionIsLive(current, now)
        ) {
          return err({ code: 'session.invalid' });
        }
        const revokedSessions = await sessions.revokeAllOf(
          market,
          actor.accountId,
          'signed-out-elsewhere',
          now,
          actor.sessionId,
        );
        await audit.record(
          context,
          OtherSessionsSignedOutAudit.entry(actor.accountId, {
            after: { keptSessionId: actor.sessionId, revokedSessions },
          }),
        );
        return ok({ code: 'other-sessions-ended', revokedSessions });
      },
    );
  }
}
