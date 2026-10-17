import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_VIEW } from '../../contracts/permissions';
import { isDraftEditable } from '../../domain/seller-certificate';
import {
  documentViewOf,
  invalid,
  ownerOf,
  parseCertificateId,
  storeFailure,
  summaryOf,
  type CertificateSummary,
  type DocumentView,
  type OwnCertificateDependencies,
  type ValidationFailure,
} from '../own/own-certificate.shared';
import type { DraftView } from './own-certificate-save-draft.use-case';

export interface OwnCertificateReadInput {
  readonly certificateId: unknown;
}

export interface OwnCertificateReadOutput {
  readonly certificate: CertificateSummary;
  readonly draft: DraftView;
  readonly documents: readonly DocumentView[];
}

export type OwnCertificateReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `own-certificate.read` (certification design 7.2, 3.3): one of the seller's own certificates
 * with its draft (the number and the note decrypted under the seller's key) and the files on the
 * draft. Rule: key `certification.own-certificate.view`; another seller's certificate and an
 * unknown id answer one `certificate.not-found`. The answer carries personal data, so the route
 * sends `Cache-Control: no-store`.
 */
export class OwnCertificateRead extends UseCase<
  OwnCertificateReadInput,
  OwnCertificateReadOutput,
  OwnCertificateReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_VIEW.key] },
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
    input: OwnCertificateReadInput,
  ): Promise<Result<OwnCertificateReadOutput, OwnCertificateReadFailure>> {
    const owner = ownerOf(context, { write: false });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');

    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(
        market,
        async () => {
          const stored = await deps.certificates.findOwn(market, owner.sellerId, certificateId);
          if (stored === null) return ok(null);
          return ok({
            stored,
            documents: await deps.certificates.listDocuments(market, certificateId),
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-certificate-read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'certificate.not-found' });
    const { stored, documents } = read.value;

    const number =
      stored.draft.certificateNumberCiphertext === null
        ? ok(null)
        : await deps.cipher.open(
            market,
            owner.sellerId,
            'draft-certificate-number',
            stored.draft.certificateNumberCiphertext,
          );
    if (!number.ok) return err({ code: 'access.denied' });
    const note =
      stored.draft.selfDeclarationNoteCiphertext === null
        ? ok(null)
        : await deps.cipher.open(
            market,
            owner.sellerId,
            'draft-self-declaration-note',
            stored.draft.selfDeclarationNoteCiphertext,
          );
    if (!note.ok) return err({ code: 'access.denied' });

    const now = deps.clock.now();
    return ok({
      certificate: summaryOf(
        stored,
        isDraftEditable(stored.status, stored.pendingSubmissionId),
        now,
      ),
      draft: {
        issuerId: stored.draft.issuerId,
        certificateNumber: number.value,
        issueDate: stored.draft.issueDate === null ? null : stored.draft.issueDate.toString(),
        expiryDate: stored.draft.expiryDate === null ? null : stored.draft.expiryDate.toString(),
        selfDeclared: stored.draft.selfDeclared,
        selfDeclarationNote: note.value,
      },
      documents: documents.map(documentViewOf),
    });
  }
}
