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
}

/** Nest token of the {@link JobCallContexts} that `IdentityModule` provides and exports. */
export const JOB_CALL_CONTEXTS = Symbol('JOB_CALL_CONTEXTS');
