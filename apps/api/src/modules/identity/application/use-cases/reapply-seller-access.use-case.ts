import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SellerAccessReappliedAudit } from '../../domain/audit';
import type {
  SellerAccessReapplyLimit,
  SellerAccessStateCode,
  SellerAccessWrongState,
} from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { readActingGrants } from '../roles/granting';

export interface ReapplySellerAccessInput {
  readonly sellerId: Id<'Seller'>;
}

export interface SellerAccessReapplied {
  readonly code: 'seller-access.reapplied';
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  /** Re-applications since the last approval, this one included. */
  readonly reapplyCount: number;
}

export type ReapplySellerAccessFailure =
  | SellerAccessWrongState
  | SellerAccessReapplyLimit
  /** The Market configures no re-apply limit: fail closed (identity design 3.3). */
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' };

export interface ReapplySellerAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerAccess: SellerAccessRepository;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly policy: IdentityMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * A rejected seller applies again (identity design 3.3 `rejected` → `pending`; AC 6; slice 9),
 * behind the seller-access contract only: `sellers`' "submit again" calls it (8.1, 8.3); no
 * screen or route offers it in Phase 2 (`ux.md` 1.3). Rule `own-resources`, allowed while the
 * seller is not approved (a rejected seller is not). Only the Seller Owner of the seller named,
 * which must be the actor's own (from its session): any other actor, seller or Staff member is
 * `access.denied`.
 *
 * The limit is the Market's (fewer than 3 since the last approval, 3.3); a Market that configures
 * none answers `access.unavailable` before any unit. One read-write unit at READ COMMITTED: the
 * seller row's lock first (item H), then the actor re-checked (`readActingGrants`: still an
 * active, verified seller-side account holding the seller system role, with its active
 * membership of this seller), then the transition in the domain: `seller-access.wrong-state`
 * unless rejected, `seller-access.reapply-limit` at the limit (the seller stays rejected). Event
 * `identity.seller-access-reapplied.v1` and audit `identity.seller-access.reapplied`.
 */
export class ReapplySellerAccess extends UseCase<
  ReapplySellerAccessInput,
  SellerAccessReapplied,
  ReapplySellerAccessFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reapply-seller-access',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('ReapplySellerAccess');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReapplySellerAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReapplySellerAccessInput,
  ): Promise<Result<SellerAccessReapplied, ReapplySellerAccessFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null ||
      actor.sellerId !== input.sellerId
    ) {
      return this.settle(context, input, err({ code: 'access.denied' }));
    }
    const limit = this.deps.policy.sellerReapplyLimit(market);
    if (limit === null) return this.settle(context, input, err({ code: 'access.unavailable' }));
    const sellerId = actor.sellerId;
    const self = { accountId: actor.accountId, population: 'seller' as const, sellerId };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<SellerAccessReapplied, ReapplySellerAccessFailure>> => {
        const { sellerAccess, memberships } = this.deps;
        const now = this.deps.clock.now();
        const locked = await sellerAccess.lockForSession(market, sellerId);
        const reading = await readActingGrants(this.deps, market, self, [], []);
        const membership = await memberships.findActiveByAccount(market, actor.accountId);
        if (
          !locked ||
          reading === null ||
          !reading.actor.holdsSystemRole ||
          membership?.state.sellerId !== sellerId
        ) {
          return err({ code: 'access.denied' });
        }
        const access = await sellerAccess.findById(market, sellerId);
        if (access === null) return err({ code: 'access.denied' });
        const before = access.state.state;
        const reapplied = access.reapply(now, limit);
        if (!reapplied.ok) return reapplied;
        await sellerAccess.save(market, access);
        await this.deps.outbox.append(context, access.pendingEvents);
        await this.deps.audit.record(
          context,
          SellerAccessReappliedAudit.entry(sellerId, {
            before: { state: before },
            after: { state: access.state.state, reapplyCount: access.state.reapplyCount },
          }),
        );
        return ok({
          code: 'seller-access.reapplied',
          sellerId,
          state: access.state.state,
          reapplyCount: access.state.reapplyCount,
        });
      },
    );
    return this.settle(context, input, result);
  }

  private settle(
    context: CallContext,
    input: ReapplySellerAccessInput,
    result: Result<SellerAccessReapplied, ReapplySellerAccessFailure>,
  ): Result<SellerAccessReapplied, ReapplySellerAccessFailure> {
    this.#logger.log({
      msg: 'identity.reapply-seller-access',
      outcome: result.ok ? result.value.code : result.error.code,
      sellerId: input.sellerId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
