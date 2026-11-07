import type { AuthenticatedActor, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { createCallContext } from '@mondapac/shared-kernel/contexts';

/**
 * The identity a background job keeps from the request that started it (catalog design 14a, 14;
 * ADR-0018 decision 4): the account and the session of the starting admin, as ids. Neither a token
 * nor a permission travels in it, and nothing here is "acting as" another person: the job is the
 * same person's, later.
 */
export interface JobIdentity {
  readonly accountId: Id<'Account'>;
  readonly sessionId: Id<'Session'>;
}

/**
 * The port `identity` implements for a job that runs as a person (platform-foundations 6.3, as
 * extended for admin jobs). It reads committed state and answers an authenticated actor of the
 * kept identity only when that person is still an active **admin** account of the Market. The
 * session does not have to be live: the page may be left, and a signed-out admin's import goes on.
 * A disabled account, another population or another Market is `null`. The actor carries no
 * permission: the gate asks `identity` again for each use case the job calls, so a role taken away
 * in the meantime stops the next call.
 */
export interface JobIdentityResolver {
  resumeAdmin(market: MarketContext, identity: JobIdentity): Promise<AuthenticatedActor | null>;
  /**
   * The seller counterpart (catalog design 14c): an authenticated seller actor of the kept seller
   * only while, in one read-only unit, the session is the account's, of this Market, of the seller
   * population and of **this** seller, carries no acting-as marker, was not revoked for any reason
   * but a sign-out and was not followed by a bulk end of the account's sessions; and the account is
   * an active seller account and still an active member of that seller. It does not read the
   * seller's access state: that is the gate's and the per-row eligibility check's.
   */
  resumeSeller(
    market: MarketContext,
    identity: SellerJobIdentity,
  ): Promise<AuthenticatedActor | null>;
}

/** The identity of a job a seller's account started: the account and session ids and the seller. */
export interface SellerJobIdentity extends JobIdentity {
  readonly sellerId: Id<'Seller'>;
}

/** Nest token of the {@link JobIdentityResolver}; `IdentityModule` provides and exports it. */
export const JOB_IDENTITY_RESOLVER = Symbol('JOB_IDENTITY_RESOLVER');

/** The context of a job that runs as the admin who started it. */
export type AdminJobContext = CallContext & { readonly actor: AuthenticatedActor };

/**
 * Builds the call context of such a job: the job's own Market and correlation id with the resumed
 * admin actor. A context is minted in `platform/` only (`contexts-are-built-by-platform`), so this
 * is the one way a module gets one; it needs the job's system context as proof that a worker is
 * running, and the identity port to say who the person still is.
 */
export class JobCallContexts {
  constructor(private readonly resolver: JobIdentityResolver) {}

  /** The admin's context, or null when the identity is no longer an active admin of the Market. */
  async asAdmin(job: CallContext, identity: JobIdentity): Promise<AdminJobContext | null> {
    if (job.actor.kind !== 'system') return null;
    const actor = await this.resolver.resumeAdmin(job.market, identity);
    if (actor === null || actor.population !== 'admin') return null;
    return createCallContext(job.market, actor, job.correlationId);
  }

  /**
   * The seller's context (catalog design 14c), or null when the identity is no longer that seller's
   * active member with a session of theirs. The actor holds no permission: the gate asks identity
   * for each use case the job calls.
   */
  async asSeller(job: CallContext, identity: SellerJobIdentity): Promise<SellerJobContext | null> {
    if (job.actor.kind !== 'system') return null;
    const actor = await this.resolver.resumeSeller(job.market, identity);
    if (
      actor === null ||
      actor.population !== 'seller' ||
      actor.sellerId !== identity.sellerId ||
      actor.accountId !== identity.accountId
    ) {
      return null;
    }
    return createCallContext(job.market, actor, job.correlationId);
  }
}

/** The context of a job that runs as the seller account that started it. */
export type SellerJobContext = CallContext & { readonly actor: AuthenticatedActor };

/** Nest token of the {@link JobCallContexts} that `IdentityModule` provides and exports. */
export const JOB_CALL_CONTEXTS = Symbol('JOB_CALL_CONTEXTS');
