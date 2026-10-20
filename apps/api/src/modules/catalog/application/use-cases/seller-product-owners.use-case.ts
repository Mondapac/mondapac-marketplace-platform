import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_FACADE_BATCH } from '../../contracts/catalog.facade';
import type { OfferSellUnitsFailure } from '../offers/offer-sell-units-request';
import type { SellerProductOwnersReader } from '../ports/seller-product-owners.reader';

export interface SellerProductOwnersInput {
  readonly productIds: readonly string[];
}

export interface SellerProductOwnersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly productOwnersReader: SellerProductOwnersReader;
}

/**
 * `sellerProductOwners`: the owning seller of each requested SELLER product, at most 200. Rule
 * `system`: for the sellers' product notices (in-app notifications package 4), whose catalog
 * events name the product only. Ids only. The request is checked whole before any read.
 */
export class SellerProductOwnersQuery extends UseCase<
  SellerProductOwnersInput,
  ReadonlyMap<Id<'Product'>, Id<'Seller'>>,
  OfferSellUnitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seller-product-owners',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerProductOwnersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerProductOwnersInput,
  ): Promise<Result<ReadonlyMap<Id<'Product'>, Id<'Seller'>>, OfferSellUnitsFailure>> {
    if (!Array.isArray(input.productIds)) {
      return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'type' }] });
    }
    if (input.productIds.length > MAX_FACADE_BATCH) return err({ code: 'batch.too-large' });
    const requested = new Set<Id<'Product'>>();
    for (const value of input.productIds as readonly unknown[]) {
      const id = typeof value === 'string' ? parseId<'Product'>(value) : null;
      if (id === null || !id.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'productIds', code: 'format' }] });
      }
      requested.add(id.value);
    }
    if (requested.size === 0) return ok(new Map());
    return this.deps.unitOfWork.run<
      ReadonlyMap<Id<'Product'>, Id<'Seller'>>,
      OfferSellUnitsFailure
    >(
      context.market,
      async () => ok(await this.deps.productOwnersReader.read(context.market, [...requested])),
      { readOnly: true },
    );
  }
}
