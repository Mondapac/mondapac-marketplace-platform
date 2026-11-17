import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SERVICE_AREA_EDIT } from '../../contracts/permissions';

/**
 * `sellers.service-area-edit-probe`: asks the gate whether the caller holds the key
 * `sellers.service-area.edit`. It reads and writes nothing. The Service area names list calls it
 * to name the row action the caller may run (Edit names…); `access.denied` means "no". The edit
 * checks the key again when it runs.
 */
export class ServiceAreaEditProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.service-area-edit-probe',
    rule: { kind: 'permissions', allOf: [SELLERS_SERVICE_AREA_EDIT.key] },
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
