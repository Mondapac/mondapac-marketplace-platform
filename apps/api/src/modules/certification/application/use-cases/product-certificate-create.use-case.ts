import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificationRecordedAudit } from '../../domain/audit';
import {
  adminOf,
  invalid,
  productFailure,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';
import { parseTypeId } from '../registry/registry.shared';

export interface ProductCertificateCreateInput {
  readonly typeId: unknown;
}

export interface ProductCertificateCreateOutput {
  readonly certificateId: string;
  readonly status: 'draft';
  readonly version: number;
}

export type ProductCertificateCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'type.not-found' }
  | { readonly code: 'type.inactive' }
  | { readonly code: 'type.manufacturer-basis-not-allowed' }
  | ValidationFailure;

const logger = new Logger('ProductCertification');

/**
 * `product-certificate.create` (certification design 3.4 row 1; ADR-0012 d3; slice 14): an admin
 * records a manufacturer certificate of one type, as an empty `draft` the admin then fills. The
 * type must exist in the Market, be active and be a third-party document type (a self-declaration
 * type has no manufacturer basis, CERT-40). The creator is the record's author and never its
 * approver (AC 20). Rule: key `certification.product-certificate.edit` (protected), the admin
 * population, not acting-as.
 */
export class ProductCertificateCreate extends UseCase<
  ProductCertificateCreateInput,
  ProductCertificateCreateOutput,
  ProductCertificateCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-create',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateCreateInput,
  ): Promise<Result<ProductCertificateCreateOutput, ProductCertificateCreateFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const typeId = parseTypeId(input.typeId);
    if (typeId === null) return invalid('typeId', 'format');
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const certificateId = deps.ids.next<'ProductCertification'>();
    const result = await deps.unitOfWork
      .run<ProductCertificateCreateOutput, ProductCertificateCreateFailure>(market, async () => {
        const type = await deps.registry.type(market, typeId);
        if (type === null) return err({ code: 'type.not-found' } as const);
        if (type.verificationMode !== 'THIRD_PARTY_DOCUMENT') {
          return err({ code: 'type.manufacturer-basis-not-allowed' } as const);
        }
        if (type.status !== 'active') return err({ code: 'type.inactive' } as const);
        await deps.products.create(market, {
          id: certificateId,
          typeId,
          authorAccountId: admin.accountId,
          now,
        });
        await deps.audit.record(
          context,
          ProductCertificationRecordedAudit.entry(certificateId, { after: { typeId } }),
        );
        return ok({ certificateId, status: 'draft' as const, version: 1 });
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-create.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.product-certificate.created',
        certificateId,
        typeId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
