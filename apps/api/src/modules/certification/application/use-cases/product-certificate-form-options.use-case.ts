import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import type { CertificateTypeCatalog } from '../ports/certificate-type-catalog';
import { adminOf, productFailure } from '../product/product-certification.shared';
import { englishNameOf } from './product-certificates-for-product.use-case';

export interface ProductCertificateFormOptionsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly types: CertificateTypeCatalog;
}

export interface ProductCertificateFormOptionsType {
  readonly typeId: string;
  readonly code: string;
  /** The English name of the published revision; null when it has none. */
  readonly name: string | null;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly requiresIssuerRegistry: boolean;
  /** The active issuers of the type, by name. */
  readonly issuers: readonly { readonly issuerId: string; readonly displayName: string }[];
}

export interface ProductCertificateFormOptionsOutput {
  readonly types: readonly ProductCertificateFormOptionsType[];
}

export type ProductCertificateFormOptionsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' };

/**
 * `product-certificates.form-options` (certification design 7.2; CERT-40): the active
 * third-party document types of the Market with their form settings and their active issuers, for
 * the manufacturer certificate form. A self-declaration type is left out: a manufacturer
 * certificate is always a document. Rule: key `certification.product-certificate.edit`; the answer
 * holds nothing personal.
 */
export class ProductCertificateFormOptions extends UseCase<
  Record<string, never>,
  ProductCertificateFormOptionsOutput,
  ProductCertificateFormOptionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-form-options',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificateFormOptionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ProductCertificateFormOptionsOutput, ProductCertificateFormOptionsFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    return deps.unitOfWork
      .run(
        market,
        async () => {
          const views = await deps.types.activeTypes(market);
          const types: ProductCertificateFormOptionsType[] = [];
          for (const view of views) {
            if (view.verificationMode !== 'THIRD_PARTY_DOCUMENT') continue;
            const issuers = await deps.types.activeIssuers(market, view.typeId);
            types.push({
              typeId: view.typeId,
              code: view.code,
              name: englishNameOf(view.names),
              requiresDocument: view.requiresDocument,
              requiresExpiry: view.requiresExpiry,
              requiresIssuerRegistry: view.requiresIssuerRegistry,
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
        productFailure(context, 'certification.product-certificate-form-options', error),
      );
  }
}
