import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';

/**
 * `certification.issuer-request-edit-probe`: asks the gate whether the caller holds
 * `certification.issuer.edit`. It reads and writes nothing. The issuer-request list calls it to
 * name the row actions the caller may run; `access.denied` means "no". The answer itself checks
 * its key, the version and the state again when it runs.
 */
export class IssuerRequestEditProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-request-edit-probe',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
