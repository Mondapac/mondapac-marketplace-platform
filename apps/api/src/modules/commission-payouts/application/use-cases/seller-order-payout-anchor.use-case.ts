import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CommissionPayoutsFailure, SellerOrderPayoutAnchor } from '../../contracts';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';

/**
 * `commission-payouts.seller-order-payout-anchor`: when a delivered seller order's money is released
 * to the seller, for promotions' cashback (customers phase 4c), which waits for it. Rule `system`.
 * Answered only for a seller order the ledger holds, by the seller the ledger names, so a cashback
 * the seller funds is debited from a seller order that can take it (Hassan M-1);
 * `commission-payouts.not-anchored` otherwise, and while its delivery is not anchored yet.
 */
export class SellerOrderPayoutAnchorQuery extends UseCase<
  Id<'SellerOrder'>,
  SellerOrderPayoutAnchor,
  CommissionPayoutsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.seller-order-payout-anchor',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Id<'SellerOrder'>,
  ): Promise<Result<SellerOrderPayoutAnchor, CommissionPayoutsFailure>> {
    const sellerOrderId = typeof input === 'string' ? parseId<'SellerOrder'>(input) : null;
    if (sellerOrderId === null || !sellerOrderId.ok) return err({ code: 'validation.failed' });
    return this.deps.unitOfWork.run<SellerOrderPayoutAnchor, CommissionPayoutsFailure>(
      context.market,
      async () => {
        const seller = await this.deps.ledger.sellerOfSellerOrder(
          context.market,
          sellerOrderId.value,
        );
        const anchor = await this.deps.anchors.find(context.market, sellerOrderId.value);
        if (seller === null || anchor === null || anchor.sellerId !== seller) {
          return err({ code: 'commission-payouts.not-anchored' } as const);
        }
        return ok({
          orderId: anchor.orderId,
          sellerOrderId: anchor.sellerOrderId,
          sellerId: anchor.sellerId,
          eligibleAt: anchor.eligibleAt,
        });
      },
      { readOnly: true },
    );
  }
}
