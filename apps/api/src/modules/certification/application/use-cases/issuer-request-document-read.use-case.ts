import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import { IssuerRequestDocumentDownloaded } from '../../domain/audit';
import {
  parseIssuerRequestId,
  type IssuerRequestDependencies,
} from '../issuer-requests/issuer-request.shared';
import { parseDocumentId } from '../own/own-certificate.shared';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ValidationFailure,
} from '../review/review.shared';

export interface IssuerRequestDocumentReadInput {
  readonly issuerRequestId: unknown;
  readonly documentId: unknown;
}

export interface IssuerRequestDocumentReadOutput {
  readonly bytes: Buffer;
  readonly contentType: 'image/jpeg' | 'image/png' | 'application/pdf';
}

export type IssuerRequestDocumentReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'document.not-found' }
  | { readonly code: 'document.download-disabled' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `issuer-requests.document-read` (certification design 7.2, 9.4 simplified): the bytes of one
 * file of an issuer request, decrypted under the seller's key, for the admin who answers it. Only
 * a file the request holds is served; an unknown id, a file of another request and a request of
 * another Market are one `document.not-found`. Each read writes
 * `certification.issuer-request.document-downloaded` before the bytes leave. Behind the same
 * switch as the reviewer's file reads (`CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED`): while it is off
 * the answer is `document.download-disabled` and nothing is read. Rule: key
 * `certification.issuer.view` and the admin population.
 */
export class IssuerRequestDocumentRead extends UseCase<
  IssuerRequestDocumentReadInput,
  IssuerRequestDocumentReadOutput,
  IssuerRequestDocumentReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-request-document-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerRequestDocumentReadInput,
  ): Promise<Result<IssuerRequestDocumentReadOutput, IssuerRequestDocumentReadFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const id = parseIssuerRequestId(input.issuerRequestId);
    if (id === null) return invalid('issuerRequestId', 'format');
    const documentId = parseDocumentId(input.documentId);
    if (documentId === null) return invalid('documentId', 'format');
    const { deps } = this;
    if (!deps.documentDownloadEnabled) return err({ code: 'document.download-disabled' });

    const { market } = context;
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.requests.find(market, id)), { readOnly: true })
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.issuer-request-document', error),
      );
    if (!read.ok) return read;
    const request = read.value;
    const document = request?.documents.find((d) => d.id === documentId);
    if (request === null || document === undefined) return err({ code: 'document.not-found' });

    let bytes: Buffer | null;
    try {
      const opened = await deps.vault.open(market, request.sellerId, document);
      if (!opened.ok) return err({ code: 'access.denied' });
      bytes = opened.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (bytes === null) return err({ code: 'document.not-found' });

    const audited = await deps.unitOfWork
      .run(market, async () => {
        await deps.audit.record(
          context,
          IssuerRequestDocumentDownloaded.entry(id, { after: { documentId } }),
        );
        return ok(undefined);
      })
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.issuer-request-document.audit', error),
      );
    if (!audited.ok) return err({ code: 'access.unavailable' });
    return ok({ bytes, contentType: document.mediaType });
  }
}
