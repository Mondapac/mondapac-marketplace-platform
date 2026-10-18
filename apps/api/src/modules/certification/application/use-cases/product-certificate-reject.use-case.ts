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
 * `product-certificate.reject` (certification design 3.4 row 4; slice 14): another person rejects the
 * named pending revision with a reason of the Market's list; see {@link decideProduct}. Rule: key
 * `certification.product-certificate.approve` (protected), not acting-as.
 */
export class ProductCertificateReject extends UseCase<
  ProductDecisionInput,
  ProductDecisionOutput,
  ProductDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-reject',
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
      'rejected',
      'certification.product-certificate-reject',
    );
  }
}
