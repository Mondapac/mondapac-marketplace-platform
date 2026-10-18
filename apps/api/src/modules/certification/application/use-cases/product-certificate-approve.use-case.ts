import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import {
  decideProduct,
  type ProductDecisionFailure,
  type ProductDecisionInput,
  type ProductDecisionOutput,
} from '../product/decide-product';
import type { ProductCertificationDependencies } from '../product/product-certification.shared';

/**
 * `product-certificate.approve` (certification design 3.4 rows 3, 5, 6; Q3, AC 20; slice 14): another
 * person approves the named pending revision; see {@link decideProduct}. Rule: key
 * `certification.product-certificate.approve` (protected: no default role holds it), not acting-as.
 */
export class ProductCertificateApprove extends UseCase<
  ProductDecisionInput,
  ProductDecisionOutput,
  ProductDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-approve',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ProductDecisionInput,
  ): Promise<Result<ProductDecisionOutput, ProductDecisionFailure>> {
    return decideProduct(
      this.deps,
      context,
      input,
      'approved',
      'certification.product-certificate-approve',
    );
  }
}
