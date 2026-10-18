import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_REVOKE } from '../../contracts/permissions';
import {
  endProduct,
  type ProductEndFailure,
  type ProductEndInput,
  type ProductEndOutput,
} from '../product/end-product';
import type { ProductCertificationDependencies } from '../product/product-certification.shared';

/**
 * `product-certificate.suspend` (certification design 3.4 row 6: `approved` → `suspended`; slice 15): an admin
 * suspends a manufacturer certificate with a reason of the Market's list; see {@link endProduct}.
 * Rule: key `certification.product-certificate.revoke` (protected: no default role holds it), not
 * acting-as.
 */
export class ProductCertificateSuspend extends UseCase<
  ProductEndInput,
  ProductEndOutput,
  ProductEndFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-suspend',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_REVOKE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ProductEndInput,
  ): Promise<Result<ProductEndOutput, ProductEndFailure>> {
    return endProduct(
      this.deps,
      context,
      input,
      'suspend',
      'certification.product-certificate-suspend',
    );
  }
}
