import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { ProductRefusal } from '../../domain/product';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import { invalid, sellerOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface OwnProductSetOwnBrandInput {
  readonly productId: unknown;
  readonly ownBrand: unknown;
}

export interface OwnProductSetOwnBrandOutput {
  readonly productId: string;
  readonly ownBrand: boolean;
}

export type OwnProductSetOwnBrandFailure =
  | ProductRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface OwnProductSetOwnBrandDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly clock: Clock;
}

/**
 * `own-product.set-own-brand` (attributes A5; closes the open point of #552): a seller says
 * whether their own SELLER product carries their own brand. The flag is what lets a seller propose
 * a brand (`own-brand.propose` refuses a seller with no such product), so before this route it
 * could never be set. Rule: the key `catalog.own-product.edit`, the seller population and a seller
 * who may sell. A product of another seller, a PLATFORM product, a discarded or withdrawn one and
 * an unknown id answer one byte-identical `product.not-found`. The flag is a column of the
 * product, not part of a revision: it changes no published content and needs no review. Setting
 * the value it already has writes nothing.
 */
export class OwnProductSetOwnBrand extends UseCase<
  OwnProductSetOwnBrandInput,
  OwnProductSetOwnBrandOutput,
  OwnProductSetOwnBrandFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-set-own-brand',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductSetOwnBrandDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductSetOwnBrandInput,
  ): Promise<Result<OwnProductSetOwnBrandOutput, OwnProductSetOwnBrandFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const productId =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (productId === null || !productId.ok) return invalid('productId', 'format');
    if (typeof input.ownBrand !== 'boolean') return invalid('ownBrand', 'type');
    const wanted = input.ownBrand;
    const { market } = context;
    const { deps } = this;

    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    try {
      return await deps.unitOfWork.run<OwnProductSetOwnBrandOutput, OwnProductSetOwnBrandFailure>(
        market,
        async () => {
          const product = await deps.products.findById(market, productId.value);
          const state = product?.state;
          if (
            product === null ||
            state === undefined ||
            state.scope !== 'SELLER' ||
            state.ownerSellerId !== sellerId ||
            state.status === 'discarded' ||
            state.status === 'withdrawn'
          ) {
            return err({ code: 'product.not-found' } as const);
          }
          const changed = product.setOwnBrand({ ownBrand: wanted, now: deps.clock.now() });
          if (!changed.ok) return err(changed.error);
          if (changed.value) await deps.products.save(market, product);
          return ok({ productId: state.id, ownBrand: wanted });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
