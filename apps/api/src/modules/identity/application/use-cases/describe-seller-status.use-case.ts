import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { AccessDecisionRepository } from '../ports/access-decision.repository';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import { isSellerOwner } from '../sellers/seller-owner';

/**
 * The status page of a seller-side account (`ux.md` S1; identity design 3.3, 8.6 row 2): ids,
 * the state code and instants, never text. Instants are ISO 8601 in UTC; the panel shows them in
 * the viewer's zone.
 */
export interface SellerStatus {
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  /** The instant of the latest state change (a decision, or a re-application). */
  readonly stateChangedAt: string;
  readonly accountCreatedAt: string;
  readonly emailConfirmedAt: string | null;
  /** The instant of the seller's latest decision (8.6 row 4), or null before any. */
  readonly decidedAt: string | null;
  /**
   * The reason of the rejection or suspension the seller is in, for the Seller Owner only
   * (decision 9, 8.6 row 2): exactly as the admin wrote it. Null for Staff, in any other state,
   * and once the reason was erased with the seller's key.
   */
  readonly reason: string | null;
  /**
   * Whether a rejected seller has used up its re-applications (3.3; 8.6 row 2: "Not approved"
   * rather than "Changes needed"). False in every other state, and while the Market configures
   * no limit (Phase 2: re-apply has no caller before `sellers`).
   */
  readonly reapplyLimitReached: boolean;
}

export type DescribeSellerStatusFailure = { readonly code: 'access.denied' };

export interface DescribeSellerStatusDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly decisions: AccessDecisionRepository;
  readonly grants: RoleGrantReader;
  readonly policy: IdentityMarketPolicy;
}

/**
 * Reads the calling seller-side account's own status (identity design 3.3, 5.2; slice 5). Rule
 * `own-resources`, allowed when the seller is not approved: it is the page a `pending` or
 * `rejected` seller lands on (`ux.md` F2 step 8). The seller is the actor's, from its session,
 * never from input; any other population is `access.denied`. One read-only unit (ADR-0025).
 *
 * Slice 9: the latest decision's instant, and its reason for the Seller Owner only (decision 9;
 * Staff read the state alone), opened under the seller's key in this read. The reason is never
 * logged.
 */
export class DescribeSellerStatus extends UseCase<
  Record<string, never>,
  SellerStatus,
  DescribeSellerStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.describe-seller-status',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescribeSellerStatusDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SellerStatus, DescribeSellerStatusFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok({
          account: await this.deps.accounts.findById(market, actor.accountId),
          seller: await this.deps.sellerAccess.findById(market, sellerId),
          decision: await this.deps.decisions.latestOf(market, sellerId),
          owner: await isSellerOwner(this.deps, market, actor.accountId),
        }),
      { readOnly: true },
    );
    if (!read.ok || read.value.account === null || read.value.seller === null) {
      return err({ code: 'access.denied' });
    }
    const { account, seller, decision, owner } = read.value;
    const state = seller.state.state;
    // The reason of the state the seller is in: a rejection while rejected, a suspension while
    // suspended; never an older decision's.
    const reason =
      owner && decision !== null && decision.decision === state ? decision.reason : null;
    const limit = this.deps.policy.sellerReapplyLimit(market);
    return ok({
      sellerId,
      state,
      stateChangedAt: seller.state.stateChangedAt.toString(),
      accountCreatedAt: account.state.createdAt.toString(),
      emailConfirmedAt: account.state.emailVerifiedAt?.toString() ?? null,
      decidedAt: decision?.decidedAt.toString() ?? null,
      reason,
      reapplyLimitReached: limit !== null && state === 'rejected' && !seller.canReapply(limit),
    });
  }
}
