import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type {
  SubmitProduct,
  SubmitProductFailure,
  SubmitProductOutput,
} from '../revisions/submit-product.service';

/** The request as the route will pass it. */
export interface PlatformProductSubmitInput {
  readonly productId: string;
  readonly replacePending: boolean;
}

export type PlatformProductSubmitFailure =
  | SubmitProductFailure
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformProductSubmitDependencies {
  readonly submit: SubmitProduct;
}

/**
 * `platform-product.submit` (catalog design 4.2 row 1, 8.2 row `platform-product.*`; CAT-41): an
 * admin submits the working copy of a PLATFORM product. Rule: the key
 * `catalog.platform-product.edit`. The request names the product and whether a pending revision
 * may be replaced; the author, scope, outcome, revision number and content all come from stored
 * state and the Market's configuration. An admin's revision publishes at once (4.3); the claim-text
 * control, the freeze and the store are {@link SubmitProduct}'s.
 */
export class PlatformProductSubmit extends UseCase<
  PlatformProductSubmitInput,
  SubmitProductOutput,
  PlatformProductSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-submit',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductSubmitInput,
  ): Promise<Result<SubmitProductOutput, PlatformProductSubmitFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fail = (path: string, code: string): Result<never, PlatformProductSubmitFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (typeof input.replacePending !== 'boolean') return fail('replacePending', 'type');
    return this.deps.submit.execute(context, {
      productId: product.value,
      replacePending: input.replacePending,
    });
  }
}
