import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_VIEW } from '../../contracts/permissions';
import { MAX_DOCUMENTS_PER_CERTIFICATE } from '../../domain/seller-certificate';
import {
  DOCUMENT_MEDIA_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_PDF_PAGES,
  type DocumentMediaType,
} from '../intake/document-inspection';
import {
  ownerOf,
  storeFailure,
  type OwnCertificateDependencies,
} from '../own/own-certificate.shared';

export interface OwnCertificateOptionsType {
  readonly code: string;
  /** The public name per locale of the published revision. */
  readonly names: Readonly<Record<string, string>>;
  readonly verificationMode: 'THIRD_PARTY_DOCUMENT' | 'SELF_DECLARATION';
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  /** The active issuers of the type, for the picker (empty when the type needs no registry). */
  readonly issuers: readonly { readonly issuerId: string; readonly displayName: string }[];
}

/**
 * The limits of a certificate's files, so the panel's help text names no number of its own
 * (seller pages design 7, 13): the intake's real limits.
 */
export interface DocumentLimits {
  readonly mediaTypes: readonly DocumentMediaType[];
  /** Bytes of one file. */
  readonly maxBytes: number;
  /** Files on one certificate. */
  readonly maxFiles: number;
  /** Pages of one PDF. */
  readonly maxPdfPages: number;
  /** Bytes of draft files one seller may hold, across certificates. */
  readonly draftQuotaBytes: number;
}

export interface OwnCertificateOptionsOutput {
  readonly types: readonly OwnCertificateOptionsType[];
  readonly documentLimits: DocumentLimits;
}

export type OwnCertificateOptionsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' };

/**
 * `certification-types.read-for-seller` (certification design 7.2): the active types of the
 * Market with their form settings and, for a registry type, the issuers a seller may pick, and the
 * limits of a certificate's files. Rule:
 * key `certification.own-certificate.view`; the answer holds nothing personal.
 */
export class OwnCertificateOptions extends UseCase<
  Record<string, never>,
  OwnCertificateOptionsOutput,
  OwnCertificateOptionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-certificate-options',
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
  ): Promise<Result<OwnCertificateOptionsOutput, OwnCertificateOptionsFailure>> {
    const owner = ownerOf(context, { write: false });
    if (owner === null) return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(
        market,
        async () => {
          const views = await deps.types.activeTypes(market);
          const types: OwnCertificateOptionsType[] = [];
          for (const view of views) {
            const issuers = view.requiresIssuerRegistry
              ? await deps.types.activeIssuers(market, view.typeId)
              : [];
            types.push({
              code: view.code,
              names: view.names,
              verificationMode: view.verificationMode,
              requiresIssuerRegistry: view.requiresIssuerRegistry,
              requiresDocument: view.requiresDocument,
              requiresExpiry: view.requiresExpiry,
              issuers: issuers.map((issuer) => ({
                issuerId: issuer.id,
                displayName: issuer.displayName,
              })),
            });
          }
          return ok({
            types,
            documentLimits: {
              mediaTypes: DOCUMENT_MEDIA_TYPES,
              maxBytes: MAX_DOCUMENT_BYTES,
              maxFiles: MAX_DOCUMENTS_PER_CERTIFICATE,
              maxPdfPages: MAX_PDF_PAGES,
              draftQuotaBytes: deps.draftQuotaBytes,
            },
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-certificate-options', error),
      );
    return read;
  }
}
