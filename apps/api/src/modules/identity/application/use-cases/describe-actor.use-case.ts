import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { SessionRepository } from '../ports/session.repository';

/**
 * The actor's own summary (identity design 8.1 `describeActor`, 8.6 rows 2 and 9). The ids and
 * codes are what the facade returns; `email` and `displayName` are personal data for the HTTP
 * summary only and never go into an event, a log or an audit row. Roles, permission keys, the
 * seller's access state and the second factor arrive with slices 5, 7 and 8a; until then they
 * are null, empty or false.
 */
export interface ActorSummary {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly sellerId: Id<'Seller'> | null;
  readonly roleId: string | null;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: string | null;
  readonly secondFactorActive: boolean;
  readonly email: string;
  /** Null for a customer (identity design 2.1). */
  readonly displayName: string | null;
  /** The panel counts idle time from its own last request (8.6 row 9). */
  readonly session: {
    readonly idleTimeoutSeconds: number;
    /** ISO 8601, UTC. */
    readonly absoluteExpiresAt: string;
  };
}

export type DescribeActorFailure = { readonly code: 'access.denied' };

export interface DescribeActorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
}

/**
 * Describes the calling actor (identity design 8.1, 8.6). Rule `own-resources`, allowed for a
 * seller that is not approved (5.2). Reads the account and the session in one read-only unit;
 * the actor's ids come from the context, never from input.
 */
export class DescribeActor extends UseCase<
  Record<string, never>,
  ActorSummary,
  DescribeActorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.describe-actor',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescribeActorDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ActorSummary, DescribeActorFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          session: await this.deps.sessions.findById(market, actor.sessionId),
        }),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const { account, session } = read.value;
    if (account === null || session === null || session.accountId !== actor.accountId) {
      return err({ code: 'access.denied' });
    }
    return ok({
      accountId: actor.accountId,
      population: actor.population,
      sellerId: actor.sellerId,
      roleId: null,
      permissionKeys: [],
      sellerAccessState: null,
      secondFactorActive: false,
      email: account.state.email.typed,
      displayName: account.state.displayName,
      session: {
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        absoluteExpiresAt: session.absoluteExpiresAt.toString(),
      },
    });
  }
}
