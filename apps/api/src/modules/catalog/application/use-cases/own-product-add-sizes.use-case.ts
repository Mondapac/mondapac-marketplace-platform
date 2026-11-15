import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  addSizesProductId,
  parseAddSizesRequest,
  type AddSizes,
  type AddSizesFailure,
  type AddSizesOutput,
} from '../products/add-sizes.service';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';

/** The request as the route passes it: the path id and the closed body. */
export interface OwnProductAddSizesInput {
  readonly productId: string;
  readonly body: unknown;
}

export type OwnProductAddSizesFailure = AddSizesFailure | { readonly code: 'seller.not-eligible' };

export interface OwnProductAddSizesDependencies {
  readonly addSizes: AddSizes;
  readonly eligibility: SellerEligibilityReader;
}

/**
 * `own-product.add-sizes` (catalog design 4.2a, 8.2; variants V9; CAT-10 change): a seller turns
 * their own Simple product into a Configurable one, once and never back. Rule: the key
 * `catalog.own-product.edit`, the seller population and a seller who may sell. The request names
 * the product, the `version` the page read, the axes, the option value of each axis for the
 * existing variant and whether a pending revision may be set aside. A product of another seller, a
 * PLATFORM product and an unknown id answer one byte-identical `product.not-found`. The guards,
 * their order and the effects are {@link AddSizes}'s; SEL-12 is asked for the owner
 * (`product-type.not-allowed`).
 */
export class OwnProductAddSizes extends UseCase<
  OwnProductAddSizesInput,
  AddSizesOutput,
  OwnProductAddSizesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-add-sizes',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductAddSizesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductAddSizesInput,
  ): Promise<Result<AddSizesOutput, OwnProductAddSizesFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (!(await this.deps.eligibility.isEligible(context, actor.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const productId = addSizesProductId(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const request = parseAddSizesRequest(input.body, false);
    if (!request.ok) return request;
    return this.deps.addSizes.execute(context, { productId, ...request.value });
  }
}
