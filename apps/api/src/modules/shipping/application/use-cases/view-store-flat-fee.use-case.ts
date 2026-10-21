import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ShippingDependencies } from '../shipping-dependencies';

export type StoreFlatFeeFailure =
  { readonly code: 'shipping.store-fee-not-found' } | { readonly code: 'shipping.unavailable' };

/**
 * `shipping.view-store-flat-fee`: the flat shipping fee of a store, for its public page. Rule
 * `anonymous`; the store is named by its public address and must be one that may sell now. An
 * unknown, malformed, retired or not-selling store and a store whose fee is not set answer alike
 * (`shipping.store-fee-not-found`): the page leaves the fee line out. A fault in either read is
 * `shipping.unavailable`, never read as "no fee". Money only, never the seller id.
 */
export class ViewStoreFlatFee extends UseCase<
  { readonly slug: unknown },
  Money,
  StoreFlatFeeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.view-store-flat-fee',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly slug: unknown },
  ): Promise<Result<Money, StoreFlatFeeFailure>> {
    const slug = input?.slug;
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 50) {
      return err({ code: 'shipping.store-fee-not-found' });
    }
    const sellerId = await this.deps.stores.sellerOf(context, slug);
    if (sellerId === 'unavailable') return err({ code: 'shipping.unavailable' });
    if (sellerId === null) return err({ code: 'shipping.store-fee-not-found' });
    try {
      return await this.deps.unitOfWork.run<Money, StoreFlatFeeFailure>(
        context.market,
        async () => {
          const record = await this.deps.fees.find(context.market, sellerId);
          return record === null ? err({ code: 'shipping.store-fee-not-found' }) : ok(record.fee);
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'shipping.unavailable' });
    }
  }
}
