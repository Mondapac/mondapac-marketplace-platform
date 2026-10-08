import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AuthenticatedActor, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import { authenticatedActor } from '@mondapac/shared-kernel/authenticated-actor';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  Authenticator,
  CredentialRejected,
  SessionCredential,
} from '../../../../platform/authz';
import { lastSeenIsDue, LAST_SEEN_INTERVAL_SECONDS, sessionIsLive } from '../../domain/session';
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
 * session by the SHA-256 of the token and the status of its account. The session must be of
 * the request's Market and the presented transport, not revoked, inside both lifetimes (6.1),
 * and its account active. Seller sessions are refused until slice 5 brings memberships. Every
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
    const { session, accountStatus } = found.value;
    if (
      session.marketId !== market.marketId ||
      session.transport !== credential.transport ||
      accountStatus !== 'active' ||
      session.population === 'seller' ||
      !sessionIsLive(session, now)
    ) {
      return err(REJECTED);
    }
    const actor = authenticatedActor(market, {
      population: session.population,
      accountId: session.accountId,
      sessionId: session.id,
      sellerId: null,
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
