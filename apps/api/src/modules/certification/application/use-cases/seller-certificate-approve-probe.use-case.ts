import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_APPROVE } from '../../contracts/permissions';

/**
 * `certification.seller-certificate-approve-probe`: asks the gate whether the caller holds
 * `certification.seller-certificate.approve`. It reads and writes nothing. The certificates queue
 * calls it to name the row actions the caller may run; `access.denied` means "no". The decision
 * itself checks its key, the version and the pending submission again when it runs.
 */
export class SellerCertificateApproveProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-approve-probe',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_APPROVE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
