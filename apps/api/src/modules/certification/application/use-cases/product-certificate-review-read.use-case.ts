import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import { ProductCertificateNumberViewedAudit } from '../../domain/audit';
import { checkCodesFor } from '../../domain/review';
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

/** The review read: the record with its numbers and the Market's checks of a manufacturer basis. */
export interface ProductCertificateReviewOut extends ProductCertificationOut {
  /** The checks a revision carries, in Market order; `required` ones gate the approval. */
  readonly reviewChecks: readonly { readonly checkCode: string; readonly required: boolean }[];
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
 * session like every decrypting admin read. It also lists the Market's review checks of a
 * manufacturer basis (slice 15 part 2), whose latest results each revision carries. Rule: key `certification.product-certificate.approve`
 * (protected), the admin population; the answer is `no-store`.
 */
export class ProductCertificateReviewRead extends UseCase<
  ProductCertificateReviewReadInput,
  ProductCertificateReviewOut,
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
  ): Promise<Result<ProductCertificateReviewOut, ProductCertificateReviewReadFailure>> {
    if (adminOf(context, { write: true }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const { deps } = this;
    const { market } = context;
    let reviewChecks: ProductCertificateReviewOut['reviewChecks'];
    try {
      // A manufacturer basis is always a third-party document type (submitRefusal).
      reviewChecks = checkCodesFor(
        deps.reviewPolicies.policyFor(market),
        'THIRD_PARTY_DOCUMENT',
      ).map(({ code, required }) => ({ checkCode: code, required }));
    } catch {
      return err({ code: 'access.unavailable' });
    }
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
    let result: ProductCertificationOut;
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
      result = {
        ...out,
        draft: { ...out.draft, certificateNumber: draftNumber },
        pending: await withNumber(out.pending, pending?.certificateNumberCiphertext),
        approved: await withNumber(out.approved, approved?.certificateNumberCiphertext),
      };
    } catch (error) {
      return productFailure(context, 'certification.product-certificate-review-read.open', error);
    }
    // Hassan M1: the numbers are answered only once their audit row is committed (never the
    // number itself; the revisions whose numbers were opened).
    const revisionIds = [pending?.id, approved?.id].filter(
      (id, index, all): id is NonNullable<typeof id> =>
        id !== undefined && all.indexOf(id) === index,
    );
    const audited = await deps.unitOfWork
      .run<true, never>(market, async () => {
        await deps.audit.record(
          context,
          ProductCertificateNumberViewedAudit.entry(certificateId, { after: { revisionIds } }),
        );
        return ok(true as const);
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-review-read.audit', error),
      );
    if (!audited.ok) return audited;
    logger.log({
      msg: 'certification.product-certificate.review-read',
      certificateId: certificateId as Id,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ ...result, reviewChecks });
  }
}
