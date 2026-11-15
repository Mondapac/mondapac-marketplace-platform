import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_PAUSE } from '../../contracts/permissions';

/**
 * `catalog.product-pause-probe`: asks the gate whether the caller holds the key `catalog.product.pause`. It reads and writes nothing. The
 * product lists call it to name the row actions the caller may run (the row Actions menu), so the
 * key is checked by the gate in one place; `access.denied` means "no". The action itself checks its
 * key again when it runs.
 */
export class ProductPauseProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-pause-probe',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_PAUSE.key] },
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
