import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  ProductCertificationApprovedAudit,
  ProductCertificationRejectedAudit,
} from '../../domain/audit';
import {
  ProductCertificationApproved,
  ProductCertificationCoverageChanged,
} from '../../domain/events';
import {
  approvalEvent,
  approvalRefusal,
  productApprovalBoundary,
  statusAfterProductDecision,
  type ProductApprovalRefusal,
} from '../../domain/product-certification';
import { reasonFor } from '../../domain/review';
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
} from './product-certification.shared';

export interface ProductDecisionInput {
  readonly certificateId: unknown;
  /** The pending revision the admin reviewed. */
  readonly revisionId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
  /** Required to reject: a code of the Market's review reasons for a `declined` outcome. */
  readonly reasonCode?: unknown;
}

export interface ProductDecisionOutput {
  readonly certificateId: string;
  readonly revisionId: string;
  readonly outcome: 'approved' | 'rejected';
  readonly status: string;
  readonly version: number;
  readonly decidedAt: string;
}

export type ProductDecisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-revision' }
  | { readonly code: 'conflict.stale' }
  | ProductApprovalRefusal
  | ValidationFailure;

const logger = new Logger('ProductCertificationDecision');

/**
 * One decision on the pending revision of a manufacturer certificate (certification design 3.4
 * rows 3, 4, 5; Q3, AC 20; slice 14), naming the revision and the root version the admin saw. The
 * decider is another person: not the record's creator, not any admin who edited the draft the
 * revision came from, not its submitter (`approval.same-admin`, and the database CHECK against the
 * author). An approval also needs the record open, the issuer `active` and of the type, the type
 * active for a record never approved, and the boundary in the Market's configured zone after now;
 * it stores the boundary, moves the approved pointer (the previous revision is superseded) and
 * publishes `product-certification-approved.v1`, or `-coverage-changed.v1` when it replaces an
 * approved revision of other coverage (T3). A rejection needs a reason of the Market's list; a
 * record never approved ends `rejected`, another keeps its approved revision. The unit locks the
 * root first, then share-locks the type and the issuer (lock order of the review).
 */
export async function decideProduct(
  deps: ProductCertificationDependencies,
  context: CallContext,
  input: ProductDecisionInput,
  outcome: 'approved' | 'rejected',
  useCase: string,
): Promise<Result<ProductDecisionOutput, ProductDecisionFailure>> {
  const admin = adminOf(context, { write: true });
  if (admin === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const certificateId = parseProductCertificationId(input.certificateId);
  if (certificateId === null) return invalid('certificateId', 'format');
  const revisionId = parseProductRevisionId(input.revisionId);
  if (revisionId === null) return invalid('revisionId', 'format');
  const version = rootVersionIn(input.version);
  if (!version.ok) return err(version.error);
  const { market } = context;

  let reasonCode: string | null = null;
  if (outcome === 'rejected') {
    if (typeof input.reasonCode !== 'string') return invalid('reasonCode', 'required');
    let policy;
    try {
      policy = deps.reviewPolicies.policyFor(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (reasonFor(policy, input.reasonCode, 'declined') === null) {
      return invalid('reasonCode', 'unknown');
    }
    reasonCode = input.reasonCode;
  } else if (input.reasonCode !== undefined && input.reasonCode !== null) {
    return invalid('reasonCode', 'not-allowed');
  }
  const marketZone = deps.marketZone(market);
  if (marketZone === null) return err({ code: 'access.unavailable' });

  const now = deps.clock.now();
  const historyId = deps.ids.next<'ProductCertificationHistory'>();
  const result = await deps.unitOfWork
    .run<ProductDecisionOutput, ProductDecisionFailure>(market, async () => {
      // Lock first, then read: every edit committed before is seen, a concurrent one waits.
      await deps.products.lock(market, certificateId, version.value, now);
      const snapshot = await snapshotOf(deps, market, certificateId);
      if (snapshot === null) return NOT_FOUND;
      const { root, pending, approved } = snapshot;
      if (pending === null || pending.id !== revisionId) {
        return err({ code: 'review.not-current-revision' } as const);
      }
      const shared = await deps.products.shareRegistryRows(market, root.typeId, pending.issuerId);
      if (shared.typeStatus === null) return err({ code: 'access.unavailable' } as const);
      const boundary = productApprovalBoundary(pending.expiryDate, marketZone);
      const refusal = approvalRefusal({
        actorAccountId: admin.accountId,
        authorAccountId: root.authorAccountId,
        editorAccountIds: pending.editorAccountIds,
        status: root.status,
        issuer:
          shared.issuer === null
            ? null
            : { state: shared.issuer.state, typeMatches: shared.issuer.typeId === root.typeId },
        typeActive: shared.typeStatus === 'active',
        hasApproval: root.approvedRevisionId !== null,
        boundary: boundary.at,
        now,
      });
      // A rejection is by another person too (design 7.1: approve, reject, reinstate); the other
      // guards are an approval's.
      if (refusal !== null && (outcome === 'approved' || refusal.code === 'approval.same-admin')) {
        return err(refusal);
      }
      const toStatus = statusAfterProductDecision(
        root.status,
        root.approvedRevisionId !== null,
        outcome,
      );
      await deps.products.decide(market, {
        certificateId,
        revisionId,
        outcome,
        expiryBoundaryAt: outcome === 'approved' ? boundary.at : null,
        boundaryZone: outcome === 'approved' ? boundary.zone : null,
        rootBoundaryAt: outcome === 'approved' && pending.typeRequiresExpiry ? boundary.at : null,
        reasonCode,
        authorAccountId: root.authorAccountId,
        deciderAccountId: admin.accountId,
        fromStatus: root.status,
        toStatus,
        historyId,
        now,
      });
      const after = { revisionId, typeRevisionId: pending.typeRevisionId };
      if (outcome === 'rejected') {
        await deps.audit.record(
          context,
          ProductCertificationRejectedAudit.entry(certificateId, { after }),
        );
      } else {
        const kind = approvalEvent(approved?.coverage ?? null, pending.coverage);
        await deps.audit.record(
          context,
          ProductCertificationApprovedAudit.entry(certificateId, {
            after: { ...after, coverageChanged: kind === 'coverage-changed' },
          }),
        );
        const aggregateVersion = version.value + 1;
        await deps.outbox.append(context, [
          kind === 'coverage-changed'
            ? ProductCertificationCoverageChanged.record({
                aggregateId: certificateId,
                aggregateVersion,
                occurredAt: now,
                payload: {
                  productCertificationId: certificateId,
                  revisionId,
                  previousRevisionId: approved!.id,
                  typeId: root.typeId,
                },
              })
            : ProductCertificationApproved.record({
                aggregateId: certificateId,
                aggregateVersion,
                occurredAt: now,
                payload: { productCertificationId: certificateId, revisionId, typeId: root.typeId },
              }),
        ]);
      }
      return ok({
        certificateId,
        revisionId,
        outcome,
        status: toStatus,
        version: version.value + 1,
        decidedAt: now.toString(),
      });
    })
    .catch((error: unknown) => productFailure(context, `${useCase}.write`, error));
  if (result.ok) {
    logger.log({
      msg: 'certification.product-certificate.decided',
      outcome,
      certificateId: certificateId as Id,
      revisionId: revisionId as Id,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
  }
  return result;
}
