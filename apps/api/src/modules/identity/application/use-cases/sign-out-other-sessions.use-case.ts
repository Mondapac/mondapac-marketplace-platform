import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { OtherSessionsSignedOutAudit } from '../../domain/audit';
import { sessionIsLive } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';

export interface SignOutOtherSessionsOutput {
  readonly code: 'other-sessions-signed-out';
  /** How many sessions were ended; 0 when this was the only one. */
  readonly revokedSessions: number;
}

export type SignOutOtherSessionsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'session.invalid' };

export interface SignOutOtherSessionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * "Sign out of all other devices" (profile package 4, active sessions): revokes every session of
 * the actor's own account except the one this request was made with, with the reason
 * `signed-out-elsewhere`. Rule `own-resources`, allowed while a seller is not approved: it only
 * takes access away, so no code is asked for. A customer is refused (no panel).
 *
 * One read-write unit. It takes the account's credential lock first, as a password change does
 * (`revokeAllOf`), so a sign-in racing it is either committed and revoked here, or opens after
 * and is a new sign-in. The current session must still be live in the unit; revoked or expired meanwhile,
 * it answers `session.invalid` and nothing changes. Records
 * `identity.account.other-sessions-signed-out` (the kept session's id and the count) even when
 * nothing else was live, so the holder's action is on record.
 */
export class SignOutOtherSessions extends UseCase<
  Record<string, never>,
  SignOutOtherSessionsOutput,
  SignOutOtherSessionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-out-other-sessions',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignOutOtherSessionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SignOutOtherSessionsOutput, SignOutOtherSessionsFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources.
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    if (actor.population === 'customer') return err({ code: 'access.denied' });
    const { accounts, sessions, audit } = this.deps;
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SignOutOtherSessionsOutput, SignOutOtherSessionsFailure>> => {
        const now = this.deps.clock.now();
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
        return ok({ code: 'other-sessions-signed-out', revokedSessions });
      },
    );
  }
}
