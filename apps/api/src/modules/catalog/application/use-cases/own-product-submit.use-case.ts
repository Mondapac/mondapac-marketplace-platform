import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type {
  SubmitProduct,
  SubmitProductFailure,
  SubmitProductOutput,
} from '../revisions/submit-product.service';

/** The request as the route passes it. */
export interface OwnProductSubmitInput {
  readonly productId: string;
  readonly replacePending: boolean;
}

export type OwnProductSubmitFailure =
  | SubmitProductFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'type.not-allowed' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnProductSubmitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly submit: SubmitProduct;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
}

/**
 * `own-product.submit` (catalog design 4.2 row 1, 8.2; OFR-01): a seller submits the working copy
 * of their own SELLER product. Rule: the key `catalog.own-product.edit`, the seller population and
 * a seller who may sell. The request names the product and whether a pending revision may be
 * replaced; the author, outcome, revision number and content come from stored state and the
 * Market's configuration. Before {@link SubmitProduct} runs, the stored product's type must be one
 * the seller may sell (SEL-12; an error from the reader is `access.unavailable`, ADR-0031). A
 * product of another seller, a PLATFORM product and an unknown id answer a byte-identical
 * `product.not-found`. The seller's revision publishes at once or waits for review by the
 * Market's `approvalRequired` and the classification of 4.3. Requested tags join with slice 8.
 */
export class OwnProductSubmit extends UseCase<
  OwnProductSubmitInput,
  SubmitProductOutput,
  OwnProductSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-submit',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductSubmitInput,
  ): Promise<Result<SubmitProductOutput, OwnProductSubmitFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const sellerId = actor.sellerId;
    if (!(await this.deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnProductSubmitFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (typeof input.replacePending !== 'boolean') return fail('replacePending', 'type');

    // SEL-12 on the stored type; ownership is answered here and again inside the submit.
    const typeCode = await this.deps.unitOfWork.run(
      market,
      async () => {
        const found = await this.deps.products.findById(market, product.value);
        return ok(
          found !== null && found.state.scope === 'SELLER' && found.state.ownerSellerId === sellerId
            ? found.state.typeCode
            : null,
        );
      },
      { readOnly: true },
    );
    if (!typeCode.ok) return err({ code: 'access.unavailable' });
    if (typeCode.value === null) return err({ code: 'product.not-found' });
    const allowed = await this.deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(typeCode.value)) return err({ code: 'type.not-allowed' });

    return this.deps.submit.execute(context, {
      productId: product.value,
      replacePending: input.replacePending,
    });
  }
}
