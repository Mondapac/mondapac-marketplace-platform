import { Logger } from '@nestjs/common';
import { canonicalJson, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_PRODUCT_CERTIFICATE_EDIT } from '../../contracts/permissions';
import { ProductCertificationEditedAudit } from '../../domain/audit';
import {
  isProductDraftEditable,
  statusAfterProductSubmit,
  submitRefusal,
  type CoverageEntry,
  type ProductSubmitRefusal,
} from '../../domain/product-certification';
import type { DraftField } from '../../domain/seller-certificate';
import type { StoredProductCertification } from '../ports/product-certification.repository';
import type { StoredType, StoredTypeRevision } from '../ports/registry.repository';
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

export interface ProductCertificateSubmitInput {
  readonly certificateId: unknown;
  readonly version: unknown;
}

export interface ProductCertificateSubmitOutput {
  readonly certificateId: string;
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly version: number;
}

export type ProductCertificateSubmitFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'certificate.not-editable' }
  | { readonly code: 'conflict.stale' }
  | ProductSubmitRefusal
  | ValidationFailure;

/** The canonical content of a revision, the input of its keyed hash (data design 3.16). */
const PRODUCT_CONTENT_SCHEMA_VERSION = 2;

const logger = new Logger('ProductCertification');

/**
 * Whether every draft coverage entry still names its product's current published revision and a
 * variant that revision publishes (M3): the draft was checked at save, a product may have moved on
 * since. A moved entry is a field of `certificate.incomplete`; the admin saves the draft again.
 */
function staleCoverage(
  coverage: readonly CoverageEntry[],
  published: ReadonlyMap<string, string>,
  variants: ReadonlyMap<string, ReadonlySet<string>>,
): DraftField[] {
  const fields: DraftField[] = [];
  coverage.forEach((entry, i) => {
    if (published.get(entry.productId) !== entry.productRevisionId) {
      fields.push({ path: `coverage[${i}].productRevisionId`, code: 'product-revision-changed' });
    } else if (entry.variantId !== null && !variants.get(entry.productId)?.has(entry.variantId)) {
      fields.push({ path: `coverage[${i}].variantId`, code: 'variant-unknown' });
    }
  });
  return fields;
}

/**
 * `product-certificate.submit` (certification design 3.4 row 2, T3; slice 14): the draft becomes
 * revision N+1, `pending`, for another person to approve. Guards (`submitRefusal`): a third-party
 * document type, active unless the record was approved before, a complete draft (a document when
 * the type requires one; every file is clean by construction of the draft link), the issuer `active` and of the type, the expiry boundary in the Market zone
 * after now; and every coverage entry still at its product's current published revision (M3,
 * `CatalogReferences` before the unit). The revision records the type revision in force (I1),
 * the draft's editors and the submitter, its files (sealed: never changed afterwards) and a keyed
 * hash of its content, files included. The write unit locks
 * the root first, then share-locks the type and the issuer and checks again. No event: nothing is
 * claimable before an approval. Rule: key `certification.product-certificate.edit`, not acting-as.
 */
export class ProductCertificateSubmit extends UseCase<
  ProductCertificateSubmitInput,
  ProductCertificateSubmitOutput,
  ProductCertificateSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.product-certificate-submit',
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
    input: ProductCertificateSubmitInput,
  ): Promise<Result<ProductCertificateSubmitOutput, ProductCertificateSubmitFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseProductCertificationId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    const version = rootVersionIn(input.version);
    if (!version.ok) return err(version.error);
    const { deps } = this;
    const { market } = context;
    const marketZone = deps.marketZone(market);
    if (marketZone === null) return err({ code: 'access.unavailable' });

    // 1. The record, its type and the type's published revision.
    const read = await deps.unitOfWork
      .run<
        {
          root: StoredProductCertification;
          type: StoredType;
          typeRevision: StoredTypeRevision;
        } | null,
        never
      >(
        market,
        async () => {
          const root = await deps.products.get(market, certificateId);
          if (root === null) return ok(null);
          const type = await deps.registry.type(market, root.typeId);
          if (type === null) throw new Error('product certification without its type');
          const typeRevision = await deps.registry.revision(market, type.publishedRevisionId);
          if (typeRevision === null) throw new Error('certification type without its revision');
          return ok({ root, type, typeRevision });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-submit.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return NOT_FOUND;
    const { root, type, typeRevision } = read.value;
    if (root.version !== version.value) return err({ code: 'conflict.stale' });
    if (!isProductDraftEditable(root.status, root.pendingRevisionId)) {
      return err({ code: 'certificate.not-editable' });
    }
    const { draft } = root;
    const settings = {
      status: type.status,
      verificationMode: type.verificationMode,
      requiresIssuerRegistry: typeRevision.content.requiresIssuerRegistry,
      requiresDocument: typeRevision.content.requiresDocument,
      requiresExpiry: typeRevision.content.requiresExpiry,
    };
    const storedDraft = {
      manufacturerName: draft.manufacturerName,
      issuerId: draft.issuerId,
      certificateNumberSet: draft.certificateNumberCiphertext !== null,
      issueDate: draft.issueDate,
      expiryDate: draft.expiryDate,
      coverage: draft.coverage,
    };
    // The issuer's state is checked under its share lock in the unit; a complete draft first.
    const early = submitRefusal({
      draft: storedDraft,
      type: settings,
      issuer: { state: 'active', typeMatches: true },
      hasApproval: root.approvedRevisionId !== null,
      documentCount: root.draftDocuments.length,
      marketZone,
      now: deps.clock.now(),
    });
    if (early !== null) return err(early);

    // 2. Coverage still current (M3), the number opened, the content hashed: outside any unit.
    let revisionNumber: string;
    let contentHash: string;
    try {
      const published = await deps.catalog.publishedProductRevisions(market, [
        ...new Set(draft.coverage.map((entry) => entry.productId)),
      ]);
      const narrowed = [
        ...new Map(
          draft.coverage
            .filter((entry) => entry.variantId !== null)
            .map((entry) => [
              entry.productId,
              { productId: entry.productId, productRevisionId: entry.productRevisionId },
            ]),
        ).values(),
      ];
      const variants =
        narrowed.length === 0 ? new Map() : await deps.catalog.variantsOf(market, narrowed);
      const stale = staleCoverage(draft.coverage, published, variants);
      if (stale.length > 0) return err({ code: 'certificate.incomplete', fields: stale });
      const number = await deps.cipher.openNumber(
        market,
        'draft',
        draft.certificateNumberCiphertext!,
      );
      revisionNumber = await deps.cipher.sealNumber(market, 'revision', number);
      const canonical = canonicalJson({
        schemaVersion: PRODUCT_CONTENT_SCHEMA_VERSION,
        typeRevisionId: type.publishedRevisionId,
        manufacturerName: draft.manufacturerName,
        issuerId: draft.issuerId,
        certificateNumber: number,
        issueDate: draft.issueDate?.toString() ?? null,
        expiryDate: draft.expiryDate?.toString() ?? null,
        coverage: [...draft.coverage]
          .map((e) => `${e.productId}|${e.productRevisionId}|${e.variantId ?? '*'}`)
          .sort(),
        // The files in order, by the hash of their stored bytes (as a seller submission's).
        documents: root.draftDocuments.map((d) => d.cleanSha256.toString('hex')),
      });
      if (!canonical.ok) return err({ code: 'access.unavailable' });
      contentHash = await deps.cipher.contentHash(market, canonical.value);
    } catch (error) {
      return productFailure(context, 'certification.product-certificate-submit.prepare', error);
    }

    // 3. One unit: lock the root first, then share the type and the issuer, check again, write.
    const now = deps.clock.now();
    const revisionId = deps.ids.next<'ProductCertificationRevision'>();
    const historyId = deps.ids.next<'ProductCertificationHistory'>();
    const result = await deps.unitOfWork
      .run<ProductCertificateSubmitOutput, ProductCertificateSubmitFailure>(market, async () => {
        await deps.products.lock(market, certificateId, version.value, now);
        const current = await deps.products.get(market, certificateId);
        if (current === null) return NOT_FOUND;
        if (!isProductDraftEditable(current.status, current.pendingRevisionId)) {
          return err({ code: 'certificate.not-editable' } as const);
        }
        const shared = await deps.products.shareRegistryRows(
          market,
          current.typeId,
          current.draft.issuerId,
        );
        if (shared.typeStatus === null) return err({ code: 'access.unavailable' } as const);
        const typeNow = await deps.registry.type(market, current.typeId);
        if (typeNow === null || typeNow.publishedRevisionId !== type.publishedRevisionId) {
          // The type was revised since the read: its settings decided the guards.
          return err({ code: 'conflict.stale' } as const);
        }
        const refusal = submitRefusal({
          draft: storedDraft,
          type: { ...settings, status: shared.typeStatus },
          issuer:
            shared.issuer === null
              ? null
              : {
                  state: shared.issuer.state,
                  typeMatches: shared.issuer.typeId === current.typeId,
                },
          hasApproval: current.approvedRevisionId !== null,
          documentCount: current.draftDocuments.length,
          marketZone,
          now,
        });
        if (refusal !== null) return err(refusal);
        const toStatus = statusAfterProductSubmit(current.status);
        const editors = [...new Set([...current.draftEditorAccountIds, admin.accountId])];
        const revisionNo = await deps.products.submit(market, {
          certificateId,
          revisionId,
          typeId: current.typeId,
          typeRevisionId: type.publishedRevisionId,
          issuerId: draft.issuerId as Id<'Issuer'>,
          manufacturerName: draft.manufacturerName!,
          certificateNumberCiphertext: revisionNumber,
          issueDate: draft.issueDate,
          expiryDate: draft.expiryDate,
          authorAccountId: current.authorAccountId,
          contentHash,
          submitterAccountId: admin.accountId,
          coverage: draft.coverage,
          editorAccountIds: editors,
          documentIds: current.draftDocuments.map((d) => d.id),
          fromStatus: current.status,
          toStatus,
          historyId,
          now,
        });
        await deps.audit.record(
          context,
          ProductCertificationEditedAudit.entry(certificateId, {
            after: {
              typeId: current.typeId,
              revisionId,
              coverageEntries: draft.coverage.length,
            },
          }),
        );
        return ok({
          certificateId,
          revisionId,
          revisionNo,
          status: toStatus,
          version: version.value + 1,
        });
      })
      .catch((error: unknown) =>
        productFailure(context, 'certification.product-certificate-submit.write', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.product-certificate.submitted',
        certificateId: certificateId as Id,
        revisionId: revisionId as Id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
