import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_VIEW } from '../../contracts/permissions';
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

export interface OwnCertificateOptionsOutput {
  readonly types: readonly OwnCertificateOptionsType[];
}

export type OwnCertificateOptionsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' };

/**
 * `certification-types.read-for-seller` (certification design 7.2): the active types of the
 * Market with their form settings and, for a registry type, the issuers a seller may pick. Rule:
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
          return ok({ types });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-certificate-options', error),
      );
    return read;
  }
}
