import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, Population } from '@mondapac/shared-kernel';

/** Where a session's token travels; a session is bound to one (identity design 6.2). */
export type SessionTransport = 'cookie' | 'bearer';

/** A population's lifetimes, fixed on the session at creation (identity design 6.1; M2). */
export interface SessionLifetime {
  readonly idleTimeoutSeconds: number;
  readonly absoluteLifetimeSeconds: number;
}

/**
 * A session (identity design 3.5; data design 3.4). No version: revocation is a set-based
 * update, and expiry is decided at read time from the `Clock`, never stored. The token is never
 * part of it; only its hash is stored, by the repository.
 */
export interface Session {
  readonly id: Id<'Session'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  /** Set if and only if the population is `seller` (from slice 5). */
  readonly sellerId: Id<'Seller'> | null;
  readonly transport: SessionTransport;
  readonly createdAt: Temporal.Instant;
  readonly lastSeenAt: Temporal.Instant;
  readonly idleTimeoutSeconds: number;
  readonly absoluteExpiresAt: Temporal.Instant;
  readonly revokedAt: Temporal.Instant | null;
  readonly revokedReason: string | null;
}

/** `lastSeenAt` is written at most once a minute per session (identity design 6.1). */
export const LAST_SEEN_INTERVAL_SECONDS = 60;

/** A session refused a lifetime that cannot hold (a configuration error caught at boot too). */
export class SessionLifetimeError extends Error {
  override readonly name = 'SessionLifetimeError';
  constructor() {
    super('A session needs a positive idle timeout no longer than its absolute lifetime');
  }
}

/**
 * Opens a session at the end of a successful sign-in (identity design 3.5, 6.3 step 7). Both
 * lifetimes are fixed now; the absolute expiry can never be extended.
 */
export function openSession(input: {
  readonly id: Id<'Session'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  /** Required for, and only for, the seller population (`sessions_seller_id_check`). */
  readonly sellerId?: Id<'Seller'> | null;
  readonly transport: SessionTransport;
  readonly lifetime: SessionLifetime;
  readonly now: Temporal.Instant;
}): Session {
  const { lifetime, now } = input;
  if (
    !Number.isInteger(lifetime.idleTimeoutSeconds) ||
    !Number.isInteger(lifetime.absoluteLifetimeSeconds) ||
    lifetime.idleTimeoutSeconds <= 0 ||
    lifetime.idleTimeoutSeconds > lifetime.absoluteLifetimeSeconds
  ) {
    throw new SessionLifetimeError();
  }
  const sellerId = input.sellerId ?? null;
  if ((input.population === 'seller') !== (sellerId !== null)) {
    // A seller session carries its seller, and only a seller session has one (slice 5).
    throw new TypeError('openSession: a seller id is required for, and only for, a seller');
  }
  return Object.freeze({
    id: input.id,
    marketId: input.marketId,
    accountId: input.accountId,
    population: input.population,
    sellerId,
    transport: input.transport,
    createdAt: now,
    lastSeenAt: now,
    idleTimeoutSeconds: lifetime.idleTimeoutSeconds,
    absoluteExpiresAt: now.add({ seconds: lifetime.absoluteLifetimeSeconds }),
    revokedAt: null,
    revokedReason: null,
  });
}

/**
 * Whether a session may authenticate a request at `now` (identity design 3.5, 6.2): not revoked,
 * before its absolute expiry and within its idle timeout of the last request. The instant of an
 * expiry is already expired.
 */
export function sessionIsLive(session: Session, now: Temporal.Instant): boolean {
  if (session.revokedAt !== null) return false;
  if (Temporal.Instant.compare(now, session.absoluteExpiresAt) >= 0) return false;
  const idleEnds = session.lastSeenAt.add({ seconds: session.idleTimeoutSeconds });
  return Temporal.Instant.compare(now, idleEnds) < 0;
}

/** Whether a request at `now` should write `lastSeenAt` (at most once a minute). */
export function lastSeenIsDue(session: Session, now: Temporal.Instant): boolean {
  const due = session.lastSeenAt.add({ seconds: LAST_SEEN_INTERVAL_SECONDS });
  return Temporal.Instant.compare(now, due) >= 0;
}

/**
 * The code of a revocation (data design 3.4: a code, checked by the table's pattern): sign-out;
 * a password reset (every session of the account); a password change (every other session);
 * slice 7b: a second factor activated or replaced (every other session, D), or reset (every
 * session, 3.6).
 */
export type SessionRevokedReason =
  | 'sign-out'
  | 'password-reset'
  | 'password-changed'
  | 'second-factor-activated'
  | 'second-factor-replaced'
  | 'second-factor-reset';
