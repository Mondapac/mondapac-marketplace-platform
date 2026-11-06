import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  addSizesProductId,
  parseAddSizesRequest,
  type AddSizes,
  type AddSizesFailure,
  type AddSizesOutput,
} from '../products/add-sizes.service';

/** The request as the route passes it: the path id and the closed body. */
export interface PlatformProductAddSizesInput {
  readonly productId: string;
  readonly body: unknown;
}

export interface PlatformProductAddSizesDependencies {
  readonly addSizes: AddSizes;
}

/**
 * `platform-product.add-sizes` (catalog design 4.2a, 8.2; variants V9; CAT-10 change): an admin
 * turns a PLATFORM Simple product into a Configurable one, once and never back. Rule: the key
 * `catalog.platform-product.edit` and the admin population. The request is the seller's plus
 * `offOfferCount`, the number of other sellers' Offers the confirm showed going off sale (their
 * sellers may not sell `configurable`, SEL-12); the count read in the unit must equal it, else
 * `confirm.count-changed` with `currentCount`. Those Offers get the cause `type-not-allowed`.
 * The guards, their order and the effects are {@link AddSizes}'s.
 */
export class PlatformProductAddSizes extends UseCase<
  PlatformProductAddSizesInput,
  AddSizesOutput,
  AddSizesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-add-sizes',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductAddSizesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductAddSizesInput,
  ): Promise<Result<AddSizesOutput, AddSizesFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const productId = addSizesProductId(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    const request = parseAddSizesRequest(input.body, true);
    if (!request.ok) return request;
    return this.deps.addSizes.execute(context, { productId, ...request.value });
  }
}
