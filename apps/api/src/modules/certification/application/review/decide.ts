import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  SellerCertificationApprovedAudit,
  SellerCertificationChangesRequestedAudit,
  SellerCertificationDeclinedAudit,
} from '../../domain/audit';
import {
  SellerCertificationApproved,
  SellerCertificationChangesRequested,
  SellerCertificationDeclined,
} from '../../domain/events';
import {
  approvalBoundary,
  approvalRefusal,
  latestChecks,
  MAX_REASON_TEXT_LENGTH,
  reasonFor,
  statusAfterDecision,
  type DecisionOutcome,
} from '../../domain/review';
import { isUsableZone } from '../../domain/validity';
import { parseCertificateId } from '../own/own-certificate.shared';
import type { ReviewSnapshot } from '../ports/review.repository';
import {
  invalid,
  parseSubmissionId,
  plainTextIn,
  policyOf,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from './review.shared';

export interface DecisionInput {
  readonly certificateId: unknown;
  /** The submission the reviewer saw (brief s5, AC 14). */
  readonly submissionId: unknown;
  /** The record's version the reviewer saw. */
  readonly version: unknown;
  /** Required to request changes or decline; a code of the Market's list. */
  readonly reasonCode?: unknown;
  readonly reasonText?: unknown;
}

export interface DecisionOutput {
  readonly certificateId: string;
  readonly submissionId: string;
  readonly outcome: DecisionOutcome;
  /** The record's status after the decision. */
  readonly status: string;
  /** The version after the decision. */
  readonly version: number;
  readonly decidedAt: string;
}

export type DecisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'review.not-current-submission' }
  | {
      readonly code: 'review.checks-incomplete';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'review.scope-missing' }
  | { readonly code: 'certificate.incomplete' }
  | { readonly code: 'certificate.revoked' }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'type.inactive' }
  | { readonly code: 'certificate.expired' }
  | { readonly code: 'seller.zone-missing' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

function currentOrRefusal(
  snapshot: ReviewSnapshot | null,
  submissionId: string,
  version: number,
): DecisionFailure | null {
  if (snapshot === null) return { code: 'certificate.not-found' };
  if (
    snapshot.submission === null ||
    !snapshot.pending ||
    snapshot.submission.id !== submissionId
  ) {
    return { code: 'review.not-current-submission' };
  }
  if (snapshot.certificate.version !== version) return { code: 'conflict.stale' };
  return null;
}

/**
 * One decision on the pending submission (certification design 3.2 rows 3 to 5): the request names
 * the submission and the record version the reviewer saw. The guards run again in the one
 * read-write unit that writes the decision row, the status history row, the root's pointers and
 * the event, under the version lock: the named submission is still the pending one, required
 * checks are recorded, the location and scope are read (third-party types), the issuer is
 * `active` and of the type, and the expiry boundary in the seller's approved zones is after now.
 * The seller's zones are read before the unit (no facade call inside a unit). A refusal to approve
 * names the guard; nothing is written. The reason text is sealed under the seller's key outside
 * the unit.
 */
export async function decide(
  deps: ReviewDependencies,
  context: CallContext,
  input: DecisionInput,
  outcome: DecisionOutcome,
): Promise<Result<DecisionOutput, DecisionFailure>> {
  const reviewer = reviewerOf(context, { write: true });
  if (reviewer === null) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null) return invalid('body', 'type');
  const certificateId = parseCertificateId(input.certificateId);
  if (certificateId === null) return invalid('certificateId', 'format');
  const submissionId = parseSubmissionId(input.submissionId);
  if (submissionId === null) return invalid('submissionId', 'format');
  if (
    typeof input.version !== 'number' ||
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    input.version > 2_147_483_646
  ) {
    return invalid('version', 'format');
  }
  const version = input.version;

  const { market } = context;
  const policy = policyOf(deps, market);
  if (policy === null) return err({ code: 'access.unavailable' });

  let reasonCode: string | null = null;
  let reasonText: string | null = null;
  if (outcome !== 'approved') {
    if (typeof input.reasonCode !== 'string') return invalid('reasonCode', 'required');
    if (reasonFor(policy, input.reasonCode, outcome) === null) {
      return invalid('reasonCode', 'unknown');
    }
    reasonCode = input.reasonCode;
    const text = plainTextIn(input.reasonText, MAX_REASON_TEXT_LENGTH, { optional: true });
    if (!text.ok) return invalid('reasonText', text.code);
    reasonText = text.value;
  } else if (input.reasonCode !== undefined && input.reasonCode !== null) {
    return invalid('reasonCode', 'not-allowed');
  } else if (input.reasonText !== undefined && input.reasonText !== null) {
    return invalid('reasonText', 'not-allowed');
  }

  // 1. The record as the reviewer saw it: names the seller, whose key and zones the rest needs.
  const first = await deps.unitOfWork
    .run(market, async () => ok(await deps.reviews.snapshot(market, certificateId)), {
      readOnly: true,
    })
    .catch((error: unknown) => reviewFailure(context, 'certification.decision.read', error));
  if (!first.ok) return first;
  const refusal = currentOrRefusal(first.value, submissionId, version);
  if (refusal !== null) return err(refusal);
  const { sellerId } = first.value!.certificate;

  // 2. Outside the unit: the seller's approved zones (approval) or the sealed reason text.
  let zones: { zone: string; addressZone: string } | null = null;
  if (outcome === 'approved') {
    try {
      const answer = await deps.zones.zonesOf(context, [sellerId]);
      const entry = answer.get(sellerId);
      if (
        entry === undefined ||
        entry.zone === null ||
        entry.addressZone === null ||
        !isUsableZone(entry.zone) ||
        !isUsableZone(entry.addressZone)
      ) {
        return err({ code: 'seller.zone-missing' });
      }
      zones = { zone: entry.zone, addressZone: entry.addressZone };
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
  let reasonTextCiphertext: string | null = null;
  if (reasonText !== null) {
    try {
      const sealed = await deps.cipher.seal(market, sellerId, 'decision-reason-text', reasonText);
      if (!sealed.ok) return err({ code: 'access.denied' });
      reasonTextCiphertext = sealed.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }

  // 3. One unit: re-read by version, check again, write the decision, the history, the root and
  // the event.
  const now = deps.clock.now();
  const historyId = deps.ids.next<'CertificationHistory'>();
  return deps.unitOfWork
    .run<DecisionOutput, DecisionFailure>(market, async () => {
      // Lock first, then read: the version guard takes the row lock, so every check, scope and
      // confirmation committed before it is seen below and a concurrent one waits (review R3).
      await deps.reviews.lockForDecision(market, certificateId, version, now);
      const snapshot = await deps.reviews.snapshot(market, certificateId);
      const again = currentOrRefusal(snapshot, submissionId, version + 1);
      if (again !== null) return err(again);
      const { certificate, submission } = snapshot!;
      const current = submission!;

      let approvedZone: string | null = null;
      let expiryBoundaryAt = null;
      if (outcome === 'approved') {
        // Fail closed: a revoked record is never approved back (design 3.2 row 3).
        if (certificate.status === 'revoked') return err({ code: 'certificate.revoked' } as const);
        const boundary = approvalBoundary(current.expiryDate, zones!);
        // The type and the issuer as they stand now, share-locked until this unit commits, so a
        // deactivation of either is seen here or waits for this approval (slice 12; AC 19).
        const registry = await deps.reviews.shareRegistryRows(
          market,
          certificate.typeId,
          current.issuer?.id ?? null,
        );
        if (registry.typeStatus === null) return err({ code: 'access.unavailable' } as const);
        const blocked = approvalRefusal({
          mode: current.verificationMode,
          policy,
          latest: latestChecks(
            current.checks.map(({ code, result, recordedAt }) => ({ code, result, recordedAt })),
          ),
          hasScope: current.scope !== null,
          requiresIssuerRegistry: current.requiresIssuerRegistry,
          issuer:
            registry.issuer === null
              ? null
              : {
                  state: registry.issuer.state,
                  typeMatches: registry.issuer.typeId === certificate.typeId,
                },
          typeActive: registry.typeStatus === 'active',
          hasApproval: certificate.approvedSubmissionId !== null,
          boundary: boundary.at,
          now,
          selfDeclared: current.selfDeclared,
        });
        if (blocked !== null) {
          if (blocked.code === 'review.checks-incomplete') {
            return err({
              code: 'review.checks-incomplete',
              fields: blocked.checks.map((path) => ({ path, code: 'not-done' })),
            } as const);
          }
          return err(blocked);
        }
        if (current.requiresDocument && current.documents.length < 1) {
          return err({ code: 'certificate.incomplete' } as const);
        }
        if (current.requiresExpiry && current.expiryDate === null) {
          return err({ code: 'certificate.incomplete' } as const);
        }
        approvedZone = boundary.zone;
        expiryBoundaryAt = boundary.at;
      }

      const toStatus = statusAfterDecision(
        certificate.status,
        certificate.approvedSubmissionId !== null,
        outcome,
      );
      await deps.reviews.decide(market, {
        certificateId,
        submissionId,
        outcome,
        accountId: reviewer.accountId,
        decidedAt: now,
        approvedZone,
        expiryBoundaryAt,
        reasonCode,
        reasonTextCiphertext,
        fromStatus: certificate.status,
        toStatus,
        historyId,
      });

      const ids = { sellerCertificationId: certificateId, sellerId, submissionId };
      const common = {
        aggregateId: certificateId,
        aggregateVersion: version + 1,
        occurredAt: now,
      };
      const after = {
        submissionId,
        typeRevisionId: current.typeRevisionId,
        kind: current.kind,
      };
      if (outcome === 'approved') {
        await deps.audit.record(
          context,
          SellerCertificationApprovedAudit.entry(certificateId, { after }),
        );
        await deps.outbox.append(context, [
          SellerCertificationApproved.record({
            ...common,
            payload: { ...ids, typeId: certificate.typeId, kind: current.kind },
          }),
        ]);
      } else if (outcome === 'changes-requested') {
        await deps.audit.record(
          context,
          SellerCertificationChangesRequestedAudit.entry(certificateId, {
            after: { ...after, reasonTextGiven: reasonText !== null },
          }),
        );
        await deps.outbox.append(context, [
          SellerCertificationChangesRequested.record({ ...common, payload: ids }),
        ]);
      } else {
        await deps.audit.record(
          context,
          SellerCertificationDeclinedAudit.entry(certificateId, {
            after: { ...after, reasonTextGiven: reasonText !== null },
          }),
        );
        await deps.outbox.append(context, [
          SellerCertificationDeclined.record({ ...common, payload: ids }),
        ]);
      }
      return ok({
        certificateId,
        submissionId,
        outcome,
        status: toStatus,
        version: version + 1,
        decidedAt: now.toString(),
      });
    })
    .catch((error: unknown) => reviewFailure(context, 'certification.decision.write', error));
}
