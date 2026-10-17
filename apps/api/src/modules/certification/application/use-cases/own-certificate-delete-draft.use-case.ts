import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import { DRAFT_SAVE_LIMITS } from '../../domain/rate-limits';
import {
  invalid,
  ownerOf,
  parseCertificateId,
  reserveLimits,
  storeFailure,
  type OwnCertificateDependencies,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';

export interface OwnCertificateDeleteDraftInput {
  readonly certificateId: unknown;
}

export type OwnCertificateDeleteDraftFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.has-submissions' }
  | { readonly code: 'conflict.stale' }
  | RateFailure
  | ValidationFailure;

/**
 * `own-certificate.delete-draft` (design 3.1, 7.2): a seller removes a certificate that never had
 * a submission, with its draft and its files (the stored objects too). It frees the place of the
 * seller and the type (T1). No event and no history row: nothing was ever submitted. Counts
 * against the draft-save limit. Rule: key `certification.own-certificate.manage`.
 */
export class OwnCertificateDeleteDraft extends UseCase<
  OwnCertificateDeleteDraftInput,
  { readonly deleted: true },
  OwnCertificateDeleteDraftFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-delete-draft',
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
    input: OwnCertificateDeleteDraftInput,
  ): Promise<Result<{ readonly deleted: true }, OwnCertificateDeleteDraftFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const { deps } = this;
    const throttled = await reserveLimits(
      deps,
      context,
      DRAFT_SAVE_LIMITS.map((limit) => ({ limit, subject: owner.accountId })),
    );
    if (throttled !== null) return err(throttled);

    const { market } = context;
    const now = deps.clock.now();
    const objectKeys: string[] = [];
    const deleted = await deps.unitOfWork
      .run<true, OwnCertificateDeleteDraftFailure>(market, async () => {
        const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
        if (stored === null) return err({ code: 'certificate.not-found' } as const);
        if (stored.submissionCount > 0)
          return err({ code: 'certificate.has-submissions' } as const);
        const documents = await deps.certificates.listDocuments(market, certificateId);
        const removed = await deps.certificates.deleteNeverSubmitted(
          market,
          owner.sellerId,
          certificateId,
        );
        if (!removed) return err({ code: 'certificate.has-submissions' } as const);
        const bytes = documents.reduce((sum, document) => sum + document.byteSize, 0);
        if (bytes > 0) await deps.certificates.releaseQuota(market, owner.sellerId, bytes, now);
        objectKeys.push(...documents.map((document) => document.objectKey));
        return ok(true as const);
      })
      .catch((error: unknown) => storeFailure(context, 'certification.delete-draft', error));
    if (!deleted.ok) return deleted;
    // The rows are gone for good; the encrypted objects follow (a missing one is not an error).
    await Promise.all(objectKeys.map((key) => deps.vault.discard(key).catch(() => undefined)));
    return ok({ deleted: true });
  }
}
