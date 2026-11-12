import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewDependencies } from '../review/review.shared';
import {
  sellerValidCertificateTypes,
  type SellerValidCertificateTypesFailure,
  type SellerValidCertificateTypesInput,
  type SellerValidCertificateTypesRow,
} from './seller-valid-certificate-types.use-case';

/** `certification.seller-valid-certificate-types-system`: the same answer for handlers and jobs. */
export class SellerValidCertificateTypesSystem extends UseCase<
  SellerValidCertificateTypesInput,
  readonly SellerValidCertificateTypesRow[],
  SellerValidCertificateTypesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-valid-certificate-types-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerValidCertificateTypesInput,
  ): Promise<
    Result<readonly SellerValidCertificateTypesRow[], SellerValidCertificateTypesFailure>
  > {
    return sellerValidCertificateTypes(this.deps, context, input);
  }
}
