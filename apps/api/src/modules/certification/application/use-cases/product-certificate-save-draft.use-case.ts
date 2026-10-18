import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificationEditedAudit } from '../../domain/audit';
import {
  isProductDraftEditable,
  parseProductDraft,
  resolveCoverage,
  type CoverageEntry,
} from '../../domain/product-certification';
import {
  adminOf,
  invalid,
  NOT_FOUND,
  parseProductCertificationId,
  productFailure,
  rootVersionIn,
  type ProductCertificationDependencies,
  type ValidationFailure,
} from '../product/product-certification.shared';

export interface ProductCertificateSaveDraftInput {
  readonly certificateId: unknown;
  /** The root's version the admin read. */
  readonly version: unknown;
  /**
   * The draft fields: `manufacturerName`, `issuerId`, `issueDate`, `expiryDate`, `coverage`
   * (each present; `null` clears it) and optionally `certificateNumber` (absent keeps it).
   */
  readonly draft: unknown;
}

export interface ProductCertificateSaveDraftOutput {
  readonly certificateId: string;
  readonly version: number;
  readonly coverageEntries: number;
}

export type ProductCertificateSaveDraftFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const logger = new Logger('ProductCertification');

/**
 * `product-certificate.save-draft` (certification design 3.4 row 1; CERT-41; M3; slice 14): the
 * admin saves the whole draft. Every covered product must be published in the Market and is
 * recorded at its current published revision (`CatalogReferences`, read before the unit: no
 * facade call inside a unit); a narrowed entry names only variants that revision publishes. The
 * number is sealed under the Market's platform subject outside the unit. The write unit locks
 * the root first (by version), checks again that the draft may be edited (no pending revision,
 * not closed) and records the editor, who can then never approve the revision this draft becomes
 * (AC 20). Rule: key `certification.product-certificate.edit` (protected), not acting-as.
 */
export class ProductCertificateSaveDraft extends UseCase<
  ProductCertificateSaveDraftInput,
  ProductCertificateSaveDraftOutput,
  ProductCertificateSaveDraftFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-save-draft',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_PRODUCT_CERTIFICATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductCertificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductCertificateSaveDraftInput,
  ): Promise<Result<ProductCertificateSaveDraftOutput, ProductCertificateSaveDraftFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);
    const parsed = parseProductDraft(input.draft);
    if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
    const draft = parsed.value;

    const { deps } = this;
    const { market } = context;

    // 1. The record and the named issuer as they stand.
    const read = await deps.unitOfWork
      .run(
        market,
        async () => {
          const root = await deps.products.get(market, certificateId);
          const issuer =
            draft.issuerId === null ? null : await deps.registry.issuer(market, draft.issuerId);
          return ok({ root, issuer });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-save-draft.read', error),
      );
    if (!read.ok) return read;
    const { root, issuer } = read.value;
    if (root === null) return NOT_FOUND;
    if (root.version !== version.value) return err({ code: 'conflict.stale' });
    if (!isProductDraftEditable(root.status, root.pendingRevisionId)) {
      return err({ code: 'certificate.not-editable' });
    }
    // An issuer of another type is not one this certificate may name (data design 3.15 FK).
    if (draft.issuerId !== null && (issuer === null || issuer.typeId !== root.typeId)) {
      return invalid('issuerId', 'unknown');
    }

    // 2. Coverage at each product's current published revision (M3), through catalog.
    let coverage: readonly CoverageEntry[] = [];
    if (draft.coverage.length > 0) {
      try {
        const productIds = draft.coverage.map((entry) => entry.productId);
        const published = await deps.catalog.publishedProductRevisions(market, productIds);
        const narrowed = draft.coverage.flatMap((entry) => {
          const productRevisionId = published.get(entry.productId);
          return entry.variantIds === null || productRevisionId === undefined
            ? []
            : [{ productId: entry.productId, productRevisionId }];
        });
        const variants =
          narrowed.length === 0 ? new Map() : await deps.catalog.variantsOf(market, narrowed);
        const resolved = resolveCoverage(draft.coverage, published, variants);
        if (!resolved.ok) return err({ code: 'validation.failed', fields: resolved.error });
        coverage = resolved.value;
      } catch (error) {
        return productFailure(
          context,
          'certification.product-certificate-save-draft.catalog',
          error,
        );
      }
    }

    // 3. The number, sealed outside the unit (absent keeps it).
    let numberCiphertext: string | null | undefined = undefined;
    try {
      if (draft.certificateNumber === null) numberCiphertext = null;
      else if (draft.certificateNumber !== undefined) {
        numberCiphertext = await deps.cipher.sealNumber(market, 'draft', draft.certificateNumber);
      }
    } catch (error) {
      return productFailure(context, 'certification.product-certificate-save-draft.seal', error);
    }

    // 4. One unit: lock first, check again, write the draft, its coverage and the editor.
    const now = deps.clock.now();
    const result = await deps.unitOfWork
      .run<ProductCertificateSaveDraftOutput, ProductCertificateSaveDraftFailure>(
        market,
        async () => {
          await deps.products.lock(market, certificateId, version.value, now);
          const current = await deps.products.get(market, certificateId);
          if (current === null) return NOT_FOUND;
          if (!isProductDraftEditable(current.status, current.pendingRevisionId)) {
            return err({ code: 'certificate.not-editable' } as const);
          }
          await deps.products.saveDraft(market, {
            certificateId,
            manufacturerName: draft.manufacturerName,
            issuerId: draft.issuerId,
            certificateNumberCiphertext: numberCiphertext,
            issueDate: draft.issueDate,
            expiryDate: draft.expiryDate,
            coverage,
            editorAccountId: admin.accountId,
            now,
          });
          await deps.audit.record(
            context,
            ProductCertificationEditedAudit.entry(certificateId, {
              after: { typeId: current.typeId, revisionId: null, coverageEntries: coverage.length },
            }),
          );
          return ok({
            certificateId,
            version: version.value + 1,
            coverageEntries: coverage.length,
          });
        },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-save-draft.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.product-certificate.draft-saved',
        certificateId: certificateId as Id,
        coverageEntries: coverage.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
