import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE } from '../../contracts/permissions';
import { ProductCertificationReinstatedAudit } from '../../domain/audit';
import { ProductCertificationApproved } from '../../domain/events';
import {
  productReinstateRefusal,
  type ProductReinstateRefusal,
} from '../../domain/product-certification-lifecycle';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  productFailure,
  rootVersionIn,
  snapshotOf,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductReinstateInput {
  readonly certificateId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
}

export interface ProductReinstateOutput {
  readonly certificateId: string;
  readonly status: 'approved';
  /** The approved revision the record is reinstated on. */
  readonly revisionId: string;
  readonly version: number;
  readonly reinstatedAt: string;
}

export type ProductReinstateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProductReinstateRefusal
  | ValidationFailure;

const logger = new Logger('ProductCertificationReinstate');

/**
 * `product-certificate.reinstate` (certification design 3.4 row 7: `suspended` → `approved`, a
 * re-review of the approved revision; 7.1; slice 15): another person than the record's creator
 * and every admin who edited or submitted the approved revision (`approval.same-admin`). One unit
 * locks the root first under the version read, re-reads it, then takes `FOR SHARE` on the type and
 * the approved revision's issuer (lock order of the review) and checks: the record is suspended,
 * its issuer still counts (`active` or `closed-to-new`), and the boundary the claim uses is ahead
 * in the Market zone when the type revision requires an expiry (no usable zone refuses). It writes
 * the status and one history row, the audit row `.reinstated` and `product-certification-approved.v1`
 * (design 3.4: catalog re-asks the tags of the type). Rule: key
 * `certification.product-certificate.approve` (protected), not acting-as. No model is called.
 */
export class ProductCertificateReinstate extends UseCase<
  ProductReinstateInput,
  ProductReinstateOutput,
  ProductReinstateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-reinstate',
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
    input: ProductReinstateInput,
  ): Promise<Result<ProductReinstateOutput, ProductReinstateFailure>> {
    const { deps } = this;
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);
    const { market } = context;
    const marketZone = deps.marketZone(market);

    const now = deps.clock.now();
    const historyId = deps.ids.next<'ProductCertificationHistory'>();
    const result = await deps.unitOfWork
      .run<ProductReinstateOutput, ProductReinstateFailure>(market, async () => {
        await deps.products.lock(market, certificateId, version.value, now);
        const snapshot = await snapshotOf(deps, market, certificateId);
        if (snapshot === null) return NOT_FOUND;
        const { root, approved } = snapshot;
        // The type and the approved revision's issuer, share-locked after the root (lock order).
        const shared =
          approved === null
            ? null
            : await deps.products.shareRegistryRows(market, root.typeId, approved.issuerId);
        if (shared !== null && shared.typeStatus === null) {
          return err({ code: 'access.unavailable' } as const);
        }
        const refusal = productReinstateRefusal({
          actorAccountId: admin.accountId,
          authorAccountId: root.authorAccountId,
          editorAccountIds: approved?.editorAccountIds ?? [],
          status: root.status,
          hasApproval: approved !== null,
          issuer:
            shared === null || shared.issuer === null
              ? null
              : { state: shared.issuer.state, typeMatches: shared.issuer.typeId === root.typeId },
          requiresExpiry: approved?.typeRequiresExpiry ?? true,
          expiryDate: approved?.expiryDate ?? null,
          storedBoundary: approved?.decision?.expiryBoundaryAt ?? null,
          marketZone,
          now,
        });
        if (refusal !== null) return err(refusal);
        await deps.products.transition(market, {
          certificateId,
          approvedRevisionId: approved!.id,
          fromStatus: root.status,
          toStatus: 'approved',
          withdrawn: null,
          reasonCode: null,
          noteCiphertext: null,
          actorAccountId: admin.accountId,
          historyId,
          now,
        });
        await deps.audit.record(
          context,
          ProductCertificationReinstatedAudit.entry(certificateId, {
            after: { revisionId: approved!.id, typeRevisionId: approved!.typeRevisionId },
          }),
        );
        await deps.outbox.append(context, [
          ProductCertificationApproved.record({
            aggregateId: certificateId,
            aggregateVersion: version.value + 1,
            occurredAt: now,
            payload: {
              productCertificationId: certificateId,
              revisionId: approved!.id,
              typeId: root.typeId,
            },
          }),
        ]);
        return ok({
          certificateId,
          status: 'approved' as const,
          revisionId: approved!.id,
          version: version.value + 1,
          reinstatedAt: now.toString(),
        });
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-reinstate.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.product-certificate.reinstated',
        certificateId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
