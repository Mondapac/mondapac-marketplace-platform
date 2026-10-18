import { err, parseId } from '@mondapac/shared-kernel';
import type { Clock, Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TimeZoneId } from '../../domain/claim-types';
import type { CoverageEntry } from '../../domain/product-certification';
import type { ProductCertificationStatus } from '../../domain/validity';
import type { CatalogReferences } from '../ports/catalog-references';
import type { ProductCertificateCipher } from '../ports/product-certificate-cipher';
import type {
  ProductCertificationRepository,
  StoredProductCertification,
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
  /** The Market's review reasons; a rejection names one of the `declined` outcome. */
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
