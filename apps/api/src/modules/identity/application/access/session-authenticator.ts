import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AuthenticatedActor, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import { authenticatedActor } from '@mondapac/shared-kernel/authenticated-actor';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  Authenticator,
  CredentialRejected,
  JobIdentity,
  JobIdentityResolver,
  SessionCredential,
} from '../../../../platform/authz';
import {
  lastSeenIsDue,
  LAST_SEEN_INTERVAL_SECONDS,
  sessionIsLive,
  type SessionRevokedReason,
} from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens } from '../ports/session-secrets';

const REJECTED: CredentialRejected = Object.freeze({ code: 'credential.rejected' });

export interface SessionAuthenticatorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sessions: SessionRepository;
  readonly tokens: SessionTokens;
  readonly clock: Clock;
}

/**
 * identity's {@link Authenticator} (identity design 4 rule 1, 6.2; platform-foundations 6.3):
 * the one file that builds authenticated actors, through the kernel's `authenticatedActor`
 * (dependency-cruiser `authenticated-actor-is-built-by-the-authenticator`).
 *
 * Per request, in a read-only unit of its own (P 3.1 row 9; ADR-0025), one call reads the
 * session by the SHA-256 of the token, the status of its account and, for a seller session, the
 * account's active membership and the state of the session's seller. The session must be of
 * the request's Market and the presented transport, not revoked, inside both lifetimes (6.1),
 * and its account active; a seller session's membership must be of its seller, and that seller
 * not suspended (slice 5). The actor carries the session's seller. Every
 * cause is the same `credential.rejected`; nothing is cached; the token is never logged.
 *
 * The once-a-minute `lastSeenAt` write runs afterwards in its own short read-write unit; a
 * failure there is logged and does not refuse the request (the read already decided).
 */
export class SessionAuthenticator implements Authenticator {
  readonly #logger = new Logger('SessionAuthenticator');

  constructor(private readonly deps: SessionAuthenticatorDependencies) {}

  async authenticate(
    market: MarketContext,
    credential: SessionCredential,
  ): Promise<Result<AuthenticatedActor, CredentialRejected>> {
    const tokenHash = this.deps.tokens.hashOf(credential.token);
    if (tokenHash === null) return err(REJECTED);
    const now = this.deps.clock.now();
    const found = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.sessions.findForAuthentication(market, tokenHash)),
      { readOnly: true },
    );
    if (!found.ok || found.value === null) return err(REJECTED);
    const { session, accountStatus, activeMembershipSellerId, sellerAccessState } = found.value;
    // 6.2, slice 5: a seller session needs the account's active membership of the session's
    // seller, and that seller not suspended; any other session carries no seller.
    const sellerHolds =
      session.population === 'seller'
        ? session.sellerId !== null &&
          activeMembershipSellerId === session.sellerId &&
          sellerAccessState !== null &&
          sellerAccessState !== 'suspended'
        : session.sellerId === null;
    if (
      session.marketId !== market.marketId ||
      session.transport !== credential.transport ||
      accountStatus !== 'active' ||
      !sellerHolds ||
      !sessionIsLive(session, now)
    ) {
      return err(REJECTED);
    }
    const actor = authenticatedActor(market, {
      population: session.population,
      accountId: session.accountId,
      sessionId: session.id,
      sellerId: session.sellerId,
    });
    if (lastSeenIsDue(session, now)) {
      try {
        await this.deps.unitOfWork.run(market, async () => {
          await this.deps.sessions.touch(
            market,
            session.id,
            now,
            now.subtract({ seconds: LAST_SEEN_INTERVAL_SECONDS }),
          );
          return ok(undefined);
        });
      } catch {
        this.#logger.warn({
          msg: 'identity.session.last-seen-not-written',
          marketId: market.marketId,
          sessionId: session.id,
        });
      }
    }
    return ok(actor);
  }
}

export interface AdminJobIdentityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
}

/**
 * The only revocation that leaves what a person started in the session running: the person signed
 * out (their import goes on). Natural expiry or idleness is no revocation at all (`revokedAt` is
 * null). **Every other reason ends the job**, including one added later: a list of the reasons that
 * stop it would fail open (a hijacked session that the real owner ends by changing the password,
 * signing out elsewhere or resetting the second factor must not keep working). Hassan M-585-1.
 */
export const SESSION_REASONS_THAT_LEAVE_JOBS: ReadonlySet<string> = new Set<SessionRevokedReason>([
  'sign-out',
]);

/**
 * identity's {@link JobIdentityResolver}: the second thing this file builds actors for, next to the
 * {@link SessionAuthenticator} (dependency-cruiser `authenticated-actor-is-built-by-the-authenticator`).
 * A background job that the admin started runs as that admin, later (catalog design 14a). In one
 * read-only unit it reads the kept session and the account: the session must be the account's, of
 * the Market and of the admin population, and the account must be active. The session may have
 * ended by the person signing out, or by its lifetime running out (neither cancels an import the
 * person started); a session that was revoked for any other reason does. Nothing is cached, and the
 * actor holds no permission: the gate asks `identity` again for every use case the job calls.
 */
export class AdminJobIdentityResolver implements JobIdentityResolver {
  constructor(private readonly deps: AdminJobIdentityDependencies) {}

  async resumeAdmin(market: MarketContext, identity: JobIdentity) {
    const found = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          session: await this.deps.sessions.findById(market, identity.sessionId),
          account: await this.deps.accounts.findById(market, identity.accountId),
        }),
      { readOnly: true },
    );
    if (!found.ok) return null;
    const { session, account } = found.value;
    if (
      session === null ||
      account === null ||
      session.marketId !== market.marketId ||
      session.accountId !== identity.accountId ||
      session.population !== 'admin' ||
      session.sellerId !== null ||
      (session.revokedAt !== null &&
        (session.revokedReason === null ||
          !SESSION_REASONS_THAT_LEAVE_JOBS.has(session.revokedReason))) ||
      account.state.population !== 'admin' ||
      account.state.status !== 'active'
    ) {
      return null;
    }
    return authenticatedActor(market, {
      population: 'admin',
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      sellerId: null,
    });
  }
}
