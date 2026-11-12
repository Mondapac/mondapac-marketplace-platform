import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  addSizesProductId,
  type AddSizes,
  type AddSizesFailure,
  type AddSizesImpact,
} from '../products/add-sizes.service';

export interface PlatformProductAddSizesImpactDependencies {
  readonly addSizes: AddSizes;
}

/** The request of the confirm's read: the path id. */
export interface PlatformProductAddSizesImpactInput {
  readonly productId: string;
}

/**
 * `platform-product.add-sizes-impact` (catalog design 4.2a): the admin's confirm before Add
 * sizes reads how many other sellers' Offers on the product would go off sale, and the product
 * `version` to send back. Rule: the key `catalog.platform-product.edit`. A read; it writes
 * nothing and spends no limit. It asks the command's first guards (the product is a PLATFORM
 * one, has not ended and is Simple; the Market lists `configurable`), so it refuses what the
 * command would; a SELLER product, another Market's id and an unknown id are one byte-identical
 * `product.not-found`.
 */
export class PlatformProductAddSizesImpact extends UseCase<
  PlatformProductAddSizesImpactInput,
  AddSizesImpact,
  AddSizesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-add-sizes-impact',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductAddSizesImpactDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductAddSizesImpactInput,
  ): Promise<Result<AddSizesImpact, AddSizesFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const productId = addSizesProductId(input.productId);
    if (productId === null) return err({ code: 'product.not-found' });
    return this.deps.addSizes.impact(context, productId);
  }
}
