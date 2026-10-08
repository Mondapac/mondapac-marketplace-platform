import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { AccountRepository } from '../ports/account.repository';
import type { SellerAccessRepository } from '../ports/seller-access.repository';

/**
 * The status page of a seller-side account (`ux.md` S1; identity design 3.3, 8.6 row 2): ids,
 * the state code and instants, never text. Instants are ISO 8601 in UTC; the panel shows them in
 * the viewer's zone.
 */
export interface SellerStatus {
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  /** The instant of the latest state change: the last decision once decisions exist (slice 9). */
  readonly stateChangedAt: string;
  readonly accountCreatedAt: string;
  readonly emailConfirmedAt: string | null;
  /**
   * The reason of a rejection or suspension, for the owner only (decision 9). Decisions and
   * their encrypted reasons arrive with slice 9; until then always null.
   */
  readonly reason: null;
}

export type DescribeSellerStatusFailure = { readonly code: 'access.denied' };

export interface DescribeSellerStatusDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sellerAccess: SellerAccessRepository;
}

/**
 * Reads the calling seller-side account's own status (identity design 3.3, 5.2; slice 5). Rule
 * `own-resources`, allowed when the seller is not approved: it is the page a `pending` or
 * `rejected` seller lands on (`ux.md` F2 step 8). The seller is the actor's, from its session,
 * never from input; any other population is `access.denied`. One read-only unit.
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
        }),
      { readOnly: true },
    );
    if (!read.ok || read.value.account === null || read.value.seller === null) {
      return err({ code: 'access.denied' });
    }
    const { account, seller } = read.value;
    return ok({
      sellerId,
      state: seller.state.state,
      stateChangedAt: seller.state.stateChangedAt.toString(),
      accountCreatedAt: account.state.createdAt.toString(),
      emailConfirmedAt: account.state.emailVerifiedAt?.toString() ?? null,
      reason: null,
    });
  }
}
