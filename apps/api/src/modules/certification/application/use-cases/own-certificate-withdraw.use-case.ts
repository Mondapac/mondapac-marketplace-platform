import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { SellerCertificationWithdrawn } from '../../domain/events';
import { isDraftEditable } from '../../domain/seller-certificate';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  storeFailure,
  summaryOf,
  type CertificateSummary,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateWithdrawInput {
  readonly certificateId: unknown;
}

export type OwnCertificateWithdrawFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.no-pending-submission' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-certificate.withdraw` (certification design 3.2 row 2, 7.2): a seller cancels the pending
 * submission. It leaves the review queue with the decision `withdrawn` (cause `cancelled`); a
 * record that was never approved goes back to `draft`, an approved or expired one keeps its
 * status with no pending submission. One history row and the event
 * `seller-certification-withdrawn.v1` are written in the same unit. Rule: key
 * `certification.own-certificate.manage`; an acting-as session is refused.
 */
export class OwnCertificateWithdraw extends UseCase<
  OwnCertificateWithdrawInput,
  CertificateSummary,
  OwnCertificateWithdrawFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-withdraw',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_MANAGE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnCertificateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnCertificateWithdrawInput,
  ): Promise<Result<CertificateSummary, OwnCertificateWithdrawFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const historyId = deps.ids.next<'CertificationHistory'>();
    return deps.unitOfWork
      .run<CertificateSummary, OwnCertificateWithdrawFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        const submissionId = stored.pendingSubmissionId;
        if (submissionId === null)
          return err({ code: 'certificate.no-pending-submission' } as const);
        const toStatus =
          stored.status === 'in-review' && stored.approvedSubmissionId === null
            ? 'draft'
            : stored.status;
        await deps.certificates.withdraw(market, {
          certificateId,
          expectedVersion: stored.version,
          submissionId,
          cause: 'cancelled',
          accountId: owner.accountId,
          decidedAt: now,
          fromStatus: stored.status,
          toStatus,
          historyId,
        });
        await deps.outbox.append(context, [
          SellerCertificationWithdrawn.record({
            aggregateId: certificateId,
            aggregateVersion: stored.version + 1,
            occurredAt: now,
            payload: {
              sellerCertificationId: certificateId,
              sellerId: owner.sellerId,
              submissionId,
              cause: 'cancelled',
            },
          }),
        ]);
        const after = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (after === null) throw new Error('withdraw: the certificate vanished');
        return ok(summaryOf(after, isDraftEditable(after.status, after.pendingSubmissionId), now));
      })
      .catch((error: unknown) => storeFailure(context, 'certification.withdraw', error));
  }
}
