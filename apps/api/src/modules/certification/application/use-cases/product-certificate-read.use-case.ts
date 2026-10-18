import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_VIEW } from '../../contracts/permissions';
import {
  adminOf,
  certificationOut,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  productFailure,
  snapshotOf,
  type ProductCertificationDependencies,
  type ProductCertificationOut,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductCertificateReadInput {
  readonly certificateId: unknown;
}

export type ProductCertificateReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'certificate.not-found' }
  | ValidationFailure;

/**
 * `product-certificate.read` (certification design 3.4, 7.1; slice 14): one manufacturer
 * certificate with its draft, its pending and approved revisions, coverage, editors and decisions.
 * Clear fields only: the number is never read back here (the review read decrypts it under the
 * approve key). One read-only unit. Rule: key `certification.product-certificate.view`, the admin
 * population.
 */
export class ProductCertificateRead extends UseCase<
  ProductCertificateReadInput,
  ProductCertificationOut,
  ProductCertificateReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateReadInput,
  ): Promise<Result<ProductCertificationOut, ProductCertificateReadFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(market, async () => ok(await snapshotOf(deps, market, certificateId)), {
        readOnly: true,
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return NOT_FOUND;
    const { root, pending, approved } = read.value;
    return ok(certificationOut(root, pending, approved));
  }
}
