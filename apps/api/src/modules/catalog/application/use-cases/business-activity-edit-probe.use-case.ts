import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_BUSINESS_ACTIVITY_EDIT } from '../../contracts/permissions';

/**
 * `catalog.business-activity-edit-probe`: asks the gate whether the caller holds the key `catalog.business-activity.edit`. It reads
 * and writes nothing. The lists call it to name the row actions the caller may run (the
 * row Actions menu); `access.denied` means "no". The action itself checks its key again when it
 * runs.
 */
export class BusinessActivityEditProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-edit-probe',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_EDIT.key] },
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
