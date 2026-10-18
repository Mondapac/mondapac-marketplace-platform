import { err, parseId } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TimeZoneId } from '../../domain/claim-types';
import type { CoverageEntry } from '../../domain/product-certification';
import type { ProductCertificationStatus } from '../../domain/validity';
import type { CatalogReferences } from '../ports/catalog-references';
import type { DocumentIntake, PlatformDocumentVault } from '../ports/document-ports';
import type { ProductCertificateCipher } from '../ports/product-certificate-cipher';
import type {
  ProductCertificationRepository,
  StoredProductCertification,
  StoredProductDocument,
  StoredProductRevision,
} from '../ports/product-certification.repository';
import type { CertificationRegistryRepository } from '../ports/registry.repository';
import type { ReviewPolicyProvider } from '../ports/review.ports';
import { invalid, type ValidationFailure } from '../review/review.shared';

export { reviewerOf as adminOf, reviewFailure as productFailure } from '../review/review.shared';
export { invalid, type ValidationFailure };

/** The ports the manufacturer certificate use cases share (slice 14); each uses its part. */
export interface ProductCertificationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductCertificationRepository;
  readonly registry: CertificationRegistryRepository;
  readonly catalog: CatalogReferences;
  readonly cipher: ProductCertificateCipher;
  /** The seller path's file intake (type from content, size cap, PDF checks; slice 15 part 2). */
  readonly intake: DocumentIntake;
  /** Encrypted storage of the admin's files under the Market's platform subject. */
  readonly documents: PlatformDocumentVault;
  /** The Market's review reasons and checks; a rejection names a reason of `declined`. */
  readonly reviewPolicies: ReviewPolicyProvider;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The Market's configured zone, which measures a manufacturer expiry (2.4 rule 3); null fails. */
  readonly marketZone: (market: MarketContext) => TimeZoneId | null;
}

export function parseProductCertificationId(raw: unknown): Id<'ProductCertification'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'ProductCertification'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseDocumentId(raw: unknown): Id<'UploadedDocument'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'UploadedDocument'>(raw);
  return parsed.ok ? parsed.value : null;
}

export function parseProductRevisionId(raw: unknown): Id<'ProductCertificationRevision'> | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<'ProductCertificationRevision'>(raw);
  return parsed.ok ? parsed.value : null;
}

/** The root's version as the admin read it: a positive whole number in the column's range. */
export function rootVersionIn(
  value: unknown,
): { ok: true; value: number } | { ok: false; error: ValidationFailure } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_646) {
    return invalid('version', 'format');
  }
  return { ok: true, value };
}

export const NOT_FOUND = err({ code: 'certificate.not-found' } as const);

/** One coverage entry as a read shows it. */
export interface CoverageEntryOut {
  readonly productId: string;
  readonly productRevisionId: string;
  readonly variantId: string | null;
}

const coverageOut = (entries: readonly CoverageEntry[]): CoverageEntryOut[] =>
  entries.map((e) => ({
    productId: e.productId,
    productRevisionId: e.productRevisionId,
    variantId: e.variantId,
  }));

/** One file as a read shows it: no object key, no hash (reviewer download stays off). */
export interface ProductDocumentOut {
  readonly documentId: string;
  readonly position: number;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly createdAt: string;
}

const documentsOut = (documents: readonly StoredProductDocument[]): ProductDocumentOut[] =>
  documents.map((d) => ({
    documentId: d.id,
    position: d.position,
    mediaType: d.mediaType,
    byteSize: d.byteSize,
    pageCount: d.pageCount,
    createdAt: d.createdAt.toString(),
  }));

/** The latest recorded result of one check code (design 3.2 rule 3). */
export interface ProductCheckOut {
  readonly checkCode: string;
  readonly result: string;
  readonly recordedBy: { readonly accountId: string };
  readonly recordedAt: string;
}

function checksOut(revision: StoredProductRevision): ProductCheckOut[] {
  // Rows come oldest first, so the last row of a code is its latest (as `latestChecks`).
  const latest = new Map<string, StoredProductRevision['checks'][number]>();
  for (const row of revision.checks) latest.set(row.code, row);
  return [...latest.values()].map((row) => ({
    checkCode: row.code,
    result: row.result,
    recordedBy: { accountId: row.recordedByAccountId },
    recordedAt: row.recordedAt.toString(),
  }));
}

export interface ProductRevisionOut {
  readonly id: string;
  readonly revisionNo: number;
  readonly typeRevisionId: string;
  readonly issuerId: string;
  readonly manufacturerName: string;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly submittedBy: { readonly accountId: string };
  readonly submittedAt: string;
  readonly editors: readonly { readonly accountId: string }[];
  readonly coverage: readonly CoverageEntryOut[];
  /** The files sealed at submission. */
  readonly documents: readonly ProductDocumentOut[];
  /** The latest result per recorded check code. */
  readonly checks: readonly ProductCheckOut[];
  readonly decision: {
    readonly outcome: string;
    readonly decidedBy: { readonly accountId: string } | null;
    readonly decidedAt: string;
    readonly reasonCode: string | null;
    readonly expiryBoundaryAt: string | null;
    readonly boundaryZone: string | null;
  } | null;
  /** Only on the review read (approve key); never on the view-key read. */
  readonly certificateNumber?: string;
}

/** The read shape of a manufacturer certificate (no number, design 7.1 view key). */
export interface ProductCertificationOut {
  readonly id: string;
  readonly typeId: string;
  readonly status: ProductCertificationStatus;
  readonly version: number;
  readonly author: { readonly accountId: string };
  readonly createdAt: string;
  readonly lastChangedAt: string;
  readonly approvedBoundaryAt: string | null;
  readonly draft: {
    readonly manufacturerName: string | null;
    readonly issuerId: string | null;
    readonly certificateNumberSet: boolean;
    readonly issueDate: string | null;
    readonly expiryDate: string | null;
    readonly coverage: readonly CoverageEntryOut[];
    readonly documents: readonly ProductDocumentOut[];
    readonly editors: readonly { readonly accountId: string }[];
    /** Only on the review read. */
    readonly certificateNumber?: string | null;
  };
  readonly pending: ProductRevisionOut | null;
  readonly approved: ProductRevisionOut | null;
}

export function revisionOut(revision: StoredProductRevision): ProductRevisionOut {
  const { decision } = revision;
  return {
    id: revision.id,
    revisionNo: revision.revisionNo,
    typeRevisionId: revision.typeRevisionId,
    issuerId: revision.issuerId,
    manufacturerName: revision.manufacturerName,
    issueDate: revision.issueDate?.toString() ?? null,
    expiryDate: revision.expiryDate?.toString() ?? null,
    submittedBy: { accountId: revision.submittedByAccountId },
    submittedAt: revision.submittedAt.toString(),
    editors: revision.editorAccountIds.map((accountId) => ({ accountId })),
    coverage: coverageOut(revision.coverage),
    documents: documentsOut(revision.documents),
    checks: checksOut(revision),
    decision:
      decision === null
        ? null
        : {
            outcome: decision.outcome,
            decidedBy:
              decision.decidedByAccountId === null
                ? null
                : { accountId: decision.decidedByAccountId },
            decidedAt: decision.decidedAt.toString(),
            reasonCode: decision.reasonCode,
            expiryBoundaryAt: decision.expiryBoundaryAt?.toString() ?? null,
            boundaryZone: decision.boundaryZone,
          },
  };
}

export function certificationOut(
  root: StoredProductCertification,
  pending: StoredProductRevision | null,
  approved: StoredProductRevision | null,
): ProductCertificationOut {
  const { draft } = root;
  return {
    id: root.id,
    typeId: root.typeId,
    status: root.status,
    version: root.version,
    author: { accountId: root.authorAccountId },
    createdAt: root.createdAt.toString(),
    lastChangedAt: root.lastChangedAt.toString(),
    // The approval decision's boundary (Hassan L2): the root keeps one only for a type that
    // requires an expiry, the job's selection.
    approvedBoundaryAt: approved?.decision?.expiryBoundaryAt?.toString() ?? null,
    draft: {
      manufacturerName: draft.manufacturerName,
      issuerId: draft.issuerId,
      certificateNumberSet: draft.certificateNumberCiphertext !== null,
      issueDate: draft.issueDate?.toString() ?? null,
      expiryDate: draft.expiryDate?.toString() ?? null,
      coverage: coverageOut(draft.coverage),
      documents: documentsOut(root.draftDocuments),
      editors: root.draftEditorAccountIds.map((accountId) => ({ accountId })),
    },
    pending: pending === null ? null : revisionOut(pending),
    approved: approved === null ? null : revisionOut(approved),
  };
}

/** The root with its pending and approved revisions, read in the caller's unit. */
export async function snapshotOf(
  deps: Pick<ProductCertificationDependencies, 'products'>,
  market: MarketContext,
  certificateId: Id<'ProductCertification'>,
): Promise<{
  readonly root: StoredProductCertification;
  readonly pending: StoredProductRevision | null;
  readonly approved: StoredProductRevision | null;
} | null> {
  const root = await deps.products.get(market, certificateId);
  if (root === null) return null;
  const pending =
    root.pendingRevisionId === null
      ? null
      : await deps.products.revision(market, certificateId, root.pendingRevisionId);
  const approved =
    root.approvedRevisionId === null
      ? null
      : await deps.products.revision(market, certificateId, root.approvedRevisionId);
  if ((root.pendingRevisionId !== null) !== (pending !== null)) {
    throw new Error('product certification without its pending revision');
  }
  if ((root.approvedRevisionId !== null) !== (approved !== null)) {
    throw new Error('product certification without its approved revision');
  }
  return { root, pending, approved };
}
