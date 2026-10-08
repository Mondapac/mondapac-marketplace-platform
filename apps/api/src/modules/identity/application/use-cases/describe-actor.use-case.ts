import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Population, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { AccountRepository } from '../ports/account.repository';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { RoleAssignmentRepository } from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';

/**
 * The actor's own summary (identity design 8.1 `describeActor`, 8.6 rows 2 and 9). The ids and
 * codes are what the facade returns; `email` and `displayName` are personal data for the HTTP
 * summary only and never go into an event, a log or an audit row. The role and the seller's
 * access state are read from slice 5; permission keys and the second factor arrive with slices
 * 8a and 7, until then empty and false.
 */
export interface ActorSummary {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
  readonly sellerId: Id<'Seller'> | null;
  /** The account's one role (Phase 2); null for a customer, who never has one (R2). */
  readonly roleId: string | null;
  readonly permissionKeys: readonly string[];
  /** The seller's access state for a seller-side actor (3.3); null otherwise. */
  readonly sellerAccessState: SellerAccessStateCode | null;
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
  readonly assignments: RoleAssignmentRepository;
  readonly sellerAccess: SellerAccessRepository;
}

/**
 * Describes the calling actor (identity design 8.1, 8.6). Rule `own-resources`, allowed for a
 * seller that is not approved (5.2). Reads the account, the session, the account's role
 * assignment and, for a seller-side actor, its seller's access state, in one read-only unit;
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
          assignment: await this.deps.assignments.findByAccount(market, actor.accountId),
          seller:
            actor.sellerId === null
              ? null
              : await this.deps.sellerAccess.findById(market, actor.sellerId),
        }),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    const { account, session, assignment, seller } = read.value;
    if (account === null || session === null || session.accountId !== actor.accountId) {
      return err({ code: 'access.denied' });
    }
    return ok({
      accountId: actor.accountId,
      population: actor.population,
      sellerId: actor.sellerId,
      roleId: assignment?.state.roleId ?? null,
      permissionKeys: [],
      sellerAccessState: seller?.state.state ?? null,
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
