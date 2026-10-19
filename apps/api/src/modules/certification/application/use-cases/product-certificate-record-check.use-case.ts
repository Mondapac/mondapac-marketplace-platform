import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import { ProductCertificationCheckRecordedAudit } from '../../domain/audit';
import { CHECK_RESULTS, checkCodesFor, type CheckResult } from '../../domain/review';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  parseProductRevisionId,
  productFailure,
  rootVersionIn,
  snapshotOf,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductCertificateRecordCheckInput {
  readonly certificateId: unknown;
  /** The pending revision the reviewer is checking. */
  readonly revisionId: unknown;
  /** The root's version the reviewer read. */
  readonly version: unknown;
  readonly checkCode: unknown;
  readonly result: unknown;
}

export interface ProductCertificateRecordCheckOutput {
  readonly certificateId: string;
  readonly revisionId: string;
  readonly checkId: string;
  readonly checkCode: string;
  readonly result: CheckResult;
  readonly recordedAt: string;
  readonly version: number;
}

export type ProductCertificateRecordCheckFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'approval.same-admin' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-revision' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `product-certificate.record-check` (certification design 3.2 rule 3, 3.4 row 3; slice 15 part
 * 2): a reviewer records the result (`done`, `problem`, `not-applicable`) of one check of the
 * Market's list for the pending revision of a manufacturer certificate. A re-recording adds a new
 * row and the latest row per code counts; every row is audited. The check must be one a
 * third-party document type carries. The reviewer is another person, as for the approval: not the
 * record's creator, nor an admin who edited or submitted the revision (`approval.same-admin`), so a
 * check an editor ticked never opens the approval. Lock first under the version read (a concurrent
 * approval waits or is stale), so the version moves. Rule: key
 * `certification.product-certificate.approve`, not acting-as.
 */
export class ProductCertificateRecordCheck extends UseCase<
  ProductCertificateRecordCheckInput,
  ProductCertificateRecordCheckOutput,
  ProductCertificateRecordCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-record-check',
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
    input: ProductCertificateRecordCheckInput,
  ): Promise<Result<ProductCertificateRecordCheckOutput, ProductCertificateRecordCheckFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const revisionId = parseProductRevisionId(input.revisionId);
    if (revisionId === null) return invalid('revisionId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);
    if (typeof input.checkCode !== 'string') return invalid('checkCode', 'type');
    const checkCode = input.checkCode;
    const result = CHECK_RESULTS.find((value) => value === input.result);
    if (result === undefined) return invalid('result', 'value');

    const { deps } = this;
    const { market } = context;
    let known: readonly { readonly code: string }[];
    try {
      known = checkCodesFor(deps.reviewPolicies.policyFor(market), 'THIRD_PARTY_DOCUMENT');
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (!known.some((check) => check.code === checkCode)) return invalid('checkCode', 'unknown');

    const now = deps.clock.now();
    const checkId = deps.ids.next<'ReviewCheck'>();
    return deps.unitOfWork
      .run<ProductCertificateRecordCheckOutput, ProductCertificateRecordCheckFailure>(
        market,
        async () => {
          await deps.products.lock(market, certificateId, version.value, now);
          const snapshot = await snapshotOf(deps, market, certificateId);
          if (snapshot === null) return NOT_FOUND;
          const { root, pending } = snapshot;
          if (pending === null || pending.id !== revisionId) {
            return err({ code: 'review.not-current-revision' } as const);
          }
          if (
            admin.accountId === root.authorAccountId ||
            pending.editorAccountIds.includes(admin.accountId)
          ) {
            return err({ code: 'approval.same-admin' } as const);
          }
          await deps.products.recordCheck(market, {
            id: checkId,
            revisionId,
            code: checkCode,
            result,
            accountId: admin.accountId,
            now,
          });
          await deps.audit.record(
            context,
            ProductCertificationCheckRecordedAudit.entry(certificateId, {
              after: { revisionId, checkId, result },
            }),
          );
          return ok({
            certificateId,
            revisionId,
            checkId,
            checkCode,
            result,
            recordedAt: now.toString(),
            version: version.value + 1,
          });
        },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-record-check', error),
      );
  }
}
