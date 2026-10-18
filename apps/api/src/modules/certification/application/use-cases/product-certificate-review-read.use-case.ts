import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE } from '../../contracts/permissions';
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

export interface ProductCertificateReviewReadInput {
  readonly certificateId: unknown;
}

export type ProductCertificateReviewReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'certificate.not-found' }
  | ValidationFailure;

const logger = new Logger('ProductCertification');

/**
 * `product-certificate.review-read` (certification design 3.4, 7.1; slice 14): the read an approver
 * works from, with the certificate number of the draft, the pending and the approved revision
 * decrypted (outside the unit, under the Market's platform subject). Refused in an acting-as
 * session like every decrypting admin read. Rule: key `certification.product-certificate.approve`
 * (protected), the admin population; the answer is `no-store`.
 */
export class ProductCertificateReviewRead extends UseCase<
  ProductCertificateReviewReadInput,
  ProductCertificationOut,
  ProductCertificateReviewReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-review-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateReviewReadInput,
  ): Promise<Result<ProductCertificationOut, ProductCertificateReviewReadFailure>> {
    if (adminOf(context, { write: true }) === null) return err({ code: 'access.denied' });
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
        productFailure(context, 'certification.product-certificate-review-read.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return NOT_FOUND;
    const { root, pending, approved } = read.value;
    const out = certificationOut(root, pending, approved);
    try {
      const draftNumber =
        root.draft.certificateNumberCiphertext === null
          ? null
          : await deps.cipher.openNumber(market, 'draft', root.draft.certificateNumberCiphertext);
      const withNumber = async (
        view: ProductCertificationOut['pending'],
        sealed: string | undefined,
      ) =>
        view === null || sealed === undefined
          ? view
          : {
              ...view,
              certificateNumber: await deps.cipher.openNumber(market, 'revision', sealed),
            };
      const result: ProductCertificationOut = {
        ...out,
        draft: { ...out.draft, certificateNumber: draftNumber },
        pending: await withNumber(out.pending, pending?.certificateNumberCiphertext),
        approved: await withNumber(out.approved, approved?.certificateNumberCiphertext),
      };
      logger.log({
        msg: 'certification.product-certificate.review-read',
        certificateId: certificateId as Id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok(result);
    } catch (error) {
      return productFailure(context, 'certification.product-certificate-review-read.open', error);
    }
  }
}
