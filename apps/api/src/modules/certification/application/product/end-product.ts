import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  ProductCertificationRevokedAudit,
  ProductCertificationSuspendedAudit,
} from '../../domain/audit';
import { ProductCertificationRevoked, ProductCertificationSuspended } from '../../domain/events';
import {
  productRevocationRefusal,
  productSuspensionRefusal,
  suspensionReason,
  type ProductRevocationRefusal,
  type ProductSuspensionRefusal,
} from '../../domain/product-certification-lifecycle';
import { MAX_REASON_TEXT_LENGTH, type ReviewPolicy } from '../../domain/review';
import { revocationReason } from '../../domain/revocation';
import { plainTextIn } from '../review/review.shared';
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
} from './product-certification.shared';

export interface ProductEndInput {
  readonly certificateId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
  /** Required: a code of the Market's review reasons for the action's outcome. */
  readonly reasonCode: unknown;
  /** Optional note, sealed under the Market's platform subject on the history row. */
  readonly reasonText?: unknown;
}

export interface ProductEndOutput {
  readonly certificateId: string;
  readonly status: 'suspended' | 'revoked';
  /** The approved revision the record holds. */
  readonly revisionId: string;
  /** The pending revision withdrawn in the same unit (a revocation only), or null. */
  readonly withdrawnRevisionId: string | null;
  readonly version: number;
  readonly changedAt: string;
}

export type ProductEndFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'conflict.stale' }
  | ProductSuspensionRefusal
  | ProductRevocationRefusal
  | ValidationFailure;

const logger = new Logger('ProductCertificationEnd');

/**
 * Suspend (design 3.4 row 6) or revoke (row 8) a manufacturer certificate with a reason of the
 * Market's list (outcome `suspended` or `revoked`) and an optional note, naming the root version
 * the admin read (slice 15). The note is sealed outside the unit. One unit locks the root first
 * (the version guard), re-reads it, checks the guards, then writes the status, one history row
 * (reason code, sealed note, the approved revision), the audit row and the event
 * (`product-certification-suspended.v1` or `-revoked.v1`) through the outbox. A revocation also
 * withdraws a pending revision (decision `withdrawn`). `evaluateClaims` grants only an `approved`
 * record, so the claim is "no" from the commit; catalog marks the certificate's tags `rechecking`
 * on the event. No type or issuer row is read, so none is share-locked. No model is called.
 */
export async function endProduct(
  deps: ProductCertificationDependencies,
  context: CallContext,
  input: ProductEndInput,
  action: 'suspend' | 'revoke',
  useCase: string,
): Promise<Result<ProductEndOutput, ProductEndFailure>> {
  const admin = adminOf(context, { write: true });
  if (admin === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const certificateId = parseProductCertificationId(input.certificateId);
  if (certificateId === null) return invalid('certificateId', 'format');
  const version = rootVersionIn(input.version);
  if (!version.ok) return err(version.error);
  const { market } = context;

  let policy: ReviewPolicy;
  try {
    policy = deps.reviewPolicies.policyFor(market);
  } catch {
    return err({ code: 'access.unavailable' });
  }
  const reason =
    action === 'suspend'
      ? suspensionReason(policy, input.reasonCode)
      : revocationReason(policy, input.reasonCode);
  if (!reason.ok) return invalid('reasonCode', reason.code);
  const text = plainTextIn(input.reasonText, MAX_REASON_TEXT_LENGTH, { optional: true });
  if (!text.ok) return invalid('reasonText', text.code);

  // Outside the unit: the note sealed under the Market's platform subject (never destroyed).
  let noteCiphertext: string | null = null;
  if (text.value !== null) {
    try {
      noteCiphertext = await deps.cipher.sealHistoryNote(market, text.value);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }

  const now = deps.clock.now();
  const historyId = deps.ids.next<'ProductCertificationHistory'>();
  const toStatus = action === 'suspend' ? 'suspended' : 'revoked';
  const result = await deps.unitOfWork
    .run<ProductEndOutput, ProductEndFailure>(market, async () => {
      // Lock first, then read: an approval, a submit or the expiry job committed before is seen.
      await deps.products.lock(market, certificateId, version.value, now);
      const snapshot = await snapshotOf(deps, market, certificateId);
      if (snapshot === null) return NOT_FOUND;
      const { root, pending, approved } = snapshot;
      const state = { status: root.status, hasApproval: approved !== null };
      const refusal =
        action === 'suspend' ? productSuspensionRefusal(state) : productRevocationRefusal(state);
      if (refusal !== null) return err(refusal);
      const withdrawn =
        action === 'revoke' && pending !== null
          ? { revisionId: pending.id, authorAccountId: pending.authorAccountId }
          : null;
      await deps.products.transition(market, {
        certificateId,
        approvedRevisionId: approved!.id,
        fromStatus: root.status,
        toStatus,
        withdrawn,
        reasonCode: reason.value.code,
        noteCiphertext,
        actorAccountId: admin.accountId,
        historyId,
        now,
      });
      const after = { revisionId: approved!.id, typeRevisionId: approved!.typeRevisionId };
      await deps.audit.record(
        context,
        action === 'suspend'
          ? ProductCertificationSuspendedAudit.entry(certificateId, {
              after: { ...after, noteGiven: noteCiphertext !== null },
            })
          : ProductCertificationRevokedAudit.entry(certificateId, {
              after: {
                ...after,
                withdrawnRevisionId: withdrawn?.revisionId ?? null,
                noteGiven: noteCiphertext !== null,
              },
            }),
      );
      const event = {
        aggregateId: certificateId,
        aggregateVersion: version.value + 1,
        occurredAt: now,
        payload: {
          productCertificationId: certificateId,
          revisionId: approved!.id,
          typeId: root.typeId,
        },
      };
      await deps.outbox.append(context, [
        action === 'suspend'
          ? ProductCertificationSuspended.record(event)
          : ProductCertificationRevoked.record(event),
      ]);
      return ok({
        certificateId,
        status: toStatus,
        revisionId: approved!.id,
        withdrawnRevisionId: withdrawn?.revisionId ?? null,
        version: version.value + 1,
        changedAt: now.toString(),
      });
    })
    .catch((error: unknown) => productFailure(context, `${useCase}.write`, error));
  if (result.ok) {
    logger.log({
      msg: `certification.product-certificate.${toStatus}`,
      certificateId,
      withdrawn: result.value.withdrawnRevisionId !== null,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
  }
  return result;
}
