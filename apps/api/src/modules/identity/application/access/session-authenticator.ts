import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuthenticatedActor, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import { authenticatedActor } from '@mondapac/shared-kernel/authenticated-actor';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  Authenticator,
  CredentialRejected,
  JobIdentity,
  JobIdentityResolver,
  SellerJobIdentity,
  SessionCredential,
} from '../../../../platform/authz';
import {
  lastSeenIsDue,
  LAST_SEEN_INTERVAL_SECONDS,
  sessionIsLive,
  type SessionRevokedReason,
} from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
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
 * person started); a session that was revoked for any other reason does, and so does a bulk end of
 * the account's sessions after the session began, even when the session had signed out first and
 * the bulk update skipped it (`sessionsInvalidatedAt`; Hassan M-585-1). Nothing is cached, and the
 * actor holds no permission: the gate asks `identity` again for every use case the job calls.
 */
export class AdminJobIdentityResolver implements Pick<JobIdentityResolver, 'resumeAdmin'> {
  constructor(private readonly deps: AdminJobIdentityDependencies) {}

  async resumeAdmin(market: MarketContext, identity: JobIdentity) {
    const found = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          session: await this.deps.sessions.findById(market, identity.sessionId),
          account: await this.deps.accounts.findById(market, identity.accountId),
          invalidatedAt: await this.deps.sessions.sessionsInvalidatedAt(market, identity.accountId),
        }),
      { readOnly: true },
    );
    if (!found.ok) return null;
    const { session, account, invalidatedAt } = found.value;
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
      // A bulk end of the account's sessions after this one began (a reset, a change, a second
      // factor change, "sign out elsewhere"), even though this session had signed out first and
      // was skipped by it (Hassan M-585-1).
      (invalidatedAt !== null && Temporal.Instant.compare(invalidatedAt, session.createdAt) >= 0) ||
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

export interface SellerJobIdentityDependencies extends AdminJobIdentityDependencies {
  readonly memberships: SellerMembershipRepository;
}

/**
 * The seller counterpart of {@link AdminJobIdentityResolver} (catalog design 14c): a background job a
 * seller's account started (the seller import) runs as that account, later. In one read-only unit it
 * reads the kept session, the account and the account's active membership. The session must be the
 * account's, of the Market, of the `seller` population and of **this** seller, with no acting-as
 * marker (Login as Seller must not start or feed a job: an acting-as session is never resumed); it
 * may have ended by a sign-out or by running out, and by nothing else (the same
 * {@link SESSION_REASONS_THAT_LEAVE_JOBS}, and the same bulk-end rule, as the admin's). The account
 * must be active and still an active member of that seller. The seller's access state is **not**
 * read: a suspension is the gate's and the per-row eligibility check's outcome, so it is not
 * confused with a lost identity. Nothing is cached and the actor holds no permission.
 */
export class SellerJobIdentityResolver implements Pick<JobIdentityResolver, 'resumeSeller'> {
  constructor(private readonly deps: SellerJobIdentityDependencies) {}

  async resumeSeller(market: MarketContext, identity: SellerJobIdentity) {
    const found = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          session: await this.deps.sessions.findById(market, identity.sessionId),
          account: await this.deps.accounts.findById(market, identity.accountId),
          membership: await this.deps.memberships.findActiveByAccount(market, identity.accountId),
          invalidatedAt: await this.deps.sessions.sessionsInvalidatedAt(market, identity.accountId),
        }),
      { readOnly: true },
    );
    if (!found.ok) return null;
    const { session, account, membership, invalidatedAt } = found.value;
    if (
      session === null ||
      account === null ||
      membership === null ||
      session.marketId !== market.marketId ||
      session.accountId !== identity.accountId ||
      session.population !== 'seller' ||
      session.sellerId !== identity.sellerId ||
      // The reserved acting-as marker (identity design 3.4 row 6): no session carries it yet; one
      // that does is never resumed.
      hasActingAsMarker(session) ||
      (session.revokedAt !== null &&
        (session.revokedReason === null ||
          !SESSION_REASONS_THAT_LEAVE_JOBS.has(session.revokedReason))) ||
      (invalidatedAt !== null && Temporal.Instant.compare(invalidatedAt, session.createdAt) >= 0) ||
      account.state.population !== 'seller' ||
      account.state.status !== 'active' ||
      membership.state.state !== 'active' ||
      membership.state.sellerId !== identity.sellerId
    ) {
      return null;
    }
    return authenticatedActor(market, {
      population: 'seller',
      accountId: identity.accountId,
      sessionId: identity.sessionId,
      sellerId: identity.sellerId,
    });
  }
}

function hasActingAsMarker(session: object): boolean {
  if (!Object.hasOwn(session, 'actingAs')) return false;
  const marker = (session as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
}

/** Both resumes behind the one port the platform names (`JOB_IDENTITY_RESOLVER`). */
export function jobIdentityResolverOf(
  admin: Pick<JobIdentityResolver, 'resumeAdmin'>,
  seller: Pick<JobIdentityResolver, 'resumeSeller'>,
): JobIdentityResolver {
  return {
    resumeAdmin: (market, identity) => admin.resumeAdmin(market, identity),
    resumeSeller: (market, identity) => seller.resumeSeller(market, identity),
  };
}
