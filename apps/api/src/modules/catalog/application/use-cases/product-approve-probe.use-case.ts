import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';

/**
 * `catalog.product-approve-probe`: asks the gate whether the caller holds the key
 * `catalog.product.approve`. It reads and writes nothing. The review queue calls it to name the row
 * actions the caller may run; `access.denied` means "no". The decision checks its key again.
 */
export class ProductApproveProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-approve-probe',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    void context;
    return Promise.resolve(ok({ held: true }));
  }
}
