import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  ProductCertificationRepository,
  ProductCertificationSummary,
  ProductDecisionWrite,
  ProductDraftWrite,
  ProductExpiryCandidate,
  ProductExpiryPage,
  ProductHistoryRow,
  ProductLifecycleWrite,
  ProductSubmitWrite,
  StoredProductCertification,
  StoredProductDecision,
  StoredProductRevision,
} from '../application/ports/product-certification.repository';
import type { RegistryRowsShared } from '../application/ports/review.repository';
import {
  PRODUCT_CERTIFICATION_STATUSES,
  type CoverageEntry,
} from '../domain/product-certification';
import type { IssuerState, ProductCertificationStatus } from '../domain/validity';
import { fromDay, toDay } from './prisma-seller-certificate.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const ISSUER_STATES: readonly string[] = ['proposed', 'active', 'closed-to-new', 'derecognised'];
const OUTCOMES: readonly string[] = ['approved', 'rejected', 'withdrawn'];
/** The unique key a concurrent submission collides on (migration 20261018170000). */
const REVISION_NO_KEY = 'product_certification_revisions_market_id_cert_id_no_key';

function statusOf(value: string): ProductCertificationStatus {
  if (!(PRODUCT_CERTIFICATION_STATUSES as readonly string[]).includes(value)) {
    throw new Error('product certification has an invalid status');
  }
  return value as ProductCertificationStatus;
}

interface CoverageRow {
  productId: string;
  productRevisionId: string;
  variantId: string | null;
}

const coverageOf = (rows: readonly CoverageRow[]): CoverageEntry[] =>
  rows
    .map((row) => ({
      productId: row.productId as Id<'Product'>,
      productRevisionId: row.productRevisionId as Id<'ProductRevision'>,
      variantId: row.variantId as Id<'Variant'> | null,
    }))
    .sort((a, b) =>
      `${a.productId}|${a.variantId ?? ''}`.localeCompare(`${b.productId}|${b.variantId ?? ''}`),
    );

const COVERAGE_SELECT = { productId: true, productRevisionId: true, variantId: true } as const;

/** The marker kind of a manufacturer revision (data design 3.18). */
const PRODUCT_REVISION_KIND = 'product-revision';

/** The root with its approved revision and decision, as the expiry job reads it. */
const EXPIRY_SELECT = {
  id: true,
  version: true,
  typeId: true,
  status: true,
  approvedRevisionId: true,
  approvedBoundaryAt: true,
  approvedRevision: {
    select: {
      typeRevisionId: true,
      expiryDate: true,
      typeRevision: { select: { requiresExpiry: true } },
      decisions: { select: { outcome: true, expiryBoundaryAt: true, boundaryZone: true } },
    },
  },
} as const;

interface ExpiryRow {
  id: string;
  version: number;
  typeId: string;
  status: string;
  approvedRevisionId: string | null;
  approvedRevision: {
    typeRevisionId: string;
    expiryDate: Date | null;
    typeRevision: { requiresExpiry: boolean };
    decisions: { outcome: string; expiryBoundaryAt: Date | null; boundaryZone: string | null }[];
  } | null;
}

/** A candidate, or null for a row without an approved revision and its approval decision. */
function expiryCandidateOf(
  row: ExpiryRow,
  warned: ReadonlyMap<string, readonly number[]>,
): ProductExpiryCandidate | null {
  const revision = row.approvedRevision;
  const decision = revision?.decisions[0];
  if (
    row.approvedRevisionId === null ||
    revision === null ||
    decision === undefined ||
    revision.decisions.length !== 1 ||
    decision.outcome !== 'approved'
  ) {
    return null;
  }
  return {
    certificateId: row.id as Id<'ProductCertification'>,
    version: row.version,
    typeId: row.typeId as Id<'CertificationType'>,
    status: statusOf(row.status),
    approvedRevisionId: row.approvedRevisionId as Id<'ProductCertificationRevision'>,
    typeRevisionId: revision.typeRevisionId as Id<'CertificationTypeRevision'>,
    requiresExpiry: revision.typeRevision.requiresExpiry,
    expiryDate: fromDay(revision.expiryDate),
    storedBoundary:
      decision.expiryBoundaryAt === null ? null : toInstant(decision.expiryBoundaryAt),
    boundaryZone: decision.boundaryZone,
    warnedThresholds: [...(warned.get(row.approvedRevisionId) ?? [])],
  };
}

/**
 * {@link ProductCertificationRepository} on `certification`'s manufacturer certificate tables
 * (data design 3.15, 3.16; migration 20261018170000), inside the caller's unit. A revision and
 * its coverage and editors are inserted before anything points at them; the root's pointers,
 * status, draft and version move only under its version (lock first). The draft's coverage is
 * replaced whole on each save; the draft's editors are cleared by an approval.
 */
export class PrismaProductCertificationRepository implements ProductCertificationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async create(
    market: MarketContext,
    root: Parameters<ProductCertificationRepository['create']>[1],
  ): Promise<void> {
    const at = toDate(root.now);
    await this.prisma.tx(market).certificationProductCertification.create({
      data: {
        id: root.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        typeId: root.typeId,
        status: 'draft',
        authorAccountId: root.authorAccountId,
        statusChangedAt: at,
        lastChangedAt: at,
        version: 1,
        createdAt: at,
      },
      select: { id: true },
    });
  }

  async lock(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationProductCertification.updateMany({
      where: { marketId: market.marketId, id: certificateId, version: expectedVersion },
      data: { version: expectedVersion + 1, lastChangedAt: toDate(now) },
    });
    if (count !== 1) throw new StaleAggregateError('product-certification', certificateId);
  }

  async get(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
  ): Promise<StoredProductCertification | null> {
    const row = await this.prisma.tx(market).certificationProductCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: {
        id: true,
        typeId: true,
        status: true,
        pendingRevisionId: true,
        approvedRevisionId: true,
        approvedBoundaryAt: true,
        draftManufacturerName: true,
        draftIssuerId: true,
        draftCertificateNumberCiphertext: true,
        draftIssueDate: true,
        draftExpiryDate: true,
        authorAccountId: true,
        statusChangedAt: true,
        lastChangedAt: true,
        version: true,
        createdAt: true,
        draftCoverage: { select: COVERAGE_SELECT },
        draftEditors: { select: { accountId: true }, orderBy: { firstEditedAt: 'asc' } },
      },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'ProductCertification'>,
      typeId: row.typeId as Id<'CertificationType'>,
      status: statusOf(row.status),
      pendingRevisionId: row.pendingRevisionId as Id<'ProductCertificationRevision'> | null,
      approvedRevisionId: row.approvedRevisionId as Id<'ProductCertificationRevision'> | null,
      approvedBoundaryAt:
        row.approvedBoundaryAt === null ? null : toInstant(row.approvedBoundaryAt),
      authorAccountId: row.authorAccountId,
      draft: {
        manufacturerName: row.draftManufacturerName,
        issuerId: row.draftIssuerId as Id<'Issuer'> | null,
        certificateNumberCiphertext: row.draftCertificateNumberCiphertext,
        issueDate: fromDay(row.draftIssueDate),
        expiryDate: fromDay(row.draftExpiryDate),
        coverage: coverageOf(row.draftCoverage),
      },
      draftEditorAccountIds: row.draftEditors.map((editor) => editor.accountId),
      statusChangedAt: toInstant(row.statusChangedAt),
      lastChangedAt: toInstant(row.lastChangedAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
    };
  }

  async revision(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    revisionId: Id<'ProductCertificationRevision'>,
  ): Promise<StoredProductRevision | null> {
    const row = await this.prisma.tx(market).certificationProductCertificationRevision.findFirst({
      where: { marketId: market.marketId, id: revisionId, productCertificationId: certificateId },
      select: {
        id: true,
        productCertificationId: true,
        typeId: true,
        typeRevisionId: true,
        typeRevision: { select: { requiresExpiry: true } },
        revisionNo: true,
        issuerId: true,
        manufacturerName: true,
        certificateNumberCiphertext: true,
        issueDate: true,
        expiryDate: true,
        authorAccountId: true,
        submittedByAccountId: true,
        submittedAt: true,
        coverage: { select: COVERAGE_SELECT },
        editors: { select: { accountId: true }, orderBy: { accountId: 'asc' } },
        decisions: {
          select: {
            outcome: true,
            expiryBoundaryAt: true,
            boundaryZone: true,
            reasonCode: true,
            decidedByAccountId: true,
            decidedAt: true,
          },
        },
      },
    });
    if (row === null) return null;
    if (row.decisions.length > 1) throw new Error('product revision has two decisions');
    const stored = row.decisions[0];
    let decision: StoredProductDecision | null = null;
    if (stored !== undefined) {
      if (!OUTCOMES.includes(stored.outcome))
        throw new Error('product decision has an invalid outcome');
      decision = {
        outcome: stored.outcome as StoredProductDecision['outcome'],
        expiryBoundaryAt:
          stored.expiryBoundaryAt === null ? null : toInstant(stored.expiryBoundaryAt),
        boundaryZone: stored.boundaryZone,
        reasonCode: stored.reasonCode,
        decidedByAccountId: stored.decidedByAccountId,
        decidedAt: toInstant(stored.decidedAt),
      };
    }
    return {
      id: row.id as Id<'ProductCertificationRevision'>,
      productCertificationId: row.productCertificationId as Id<'ProductCertification'>,
      typeId: row.typeId as Id<'CertificationType'>,
      typeRevisionId: row.typeRevisionId as Id<'CertificationTypeRevision'>,
      typeRequiresExpiry: row.typeRevision.requiresExpiry,
      revisionNo: row.revisionNo,
      issuerId: row.issuerId as Id<'Issuer'>,
      manufacturerName: row.manufacturerName,
      certificateNumberCiphertext: row.certificateNumberCiphertext,
      issueDate: fromDay(row.issueDate),
      expiryDate: fromDay(row.expiryDate),
      authorAccountId: row.authorAccountId,
      submittedByAccountId: row.submittedByAccountId,
      submittedAt: toInstant(row.submittedAt),
      coverage: coverageOf(row.coverage),
      editorAccountIds: row.editors.map((editor) => editor.accountId),
      decision,
    };
  }

  async saveDraft(market: MarketContext, write: ProductDraftWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    const { count } = await tx.certificationProductCertification.updateMany({
      where: { marketId: market.marketId, id: write.certificateId },
      data: {
        draftManufacturerName: write.manufacturerName,
        draftIssuerId: write.issuerId,
        ...(write.certificateNumberCiphertext === undefined
          ? {}
          : { draftCertificateNumberCiphertext: write.certificateNumberCiphertext }),
        draftIssueDate: toDay(write.issueDate),
        draftExpiryDate: toDay(write.expiryDate),
      },
    });
    if (count !== 1) throw new StaleAggregateError('product-certification', write.certificateId);
    await tx.certificationProductDraftCoverage.deleteMany({
      where: { marketId: market.marketId, productCertificationId: write.certificateId },
    });
    if (write.coverage.length > 0) {
      await tx.certificationProductDraftCoverage.createMany({
        data: write.coverage.map((entry) => ({
          ...base,
          id: this.ids.next<'ProductDraftCoverage'>(),
          productCertificationId: write.certificateId,
          productId: entry.productId,
          productRevisionId: entry.productRevisionId,
          variantId: entry.variantId,
        })),
      });
    }
    await tx.certificationProductDraftEditor.createMany({
      data: [
        {
          ...base,
          productCertificationId: write.certificateId,
          accountId: write.editorAccountId,
          firstEditedAt: toDate(write.now),
        },
      ],
      skipDuplicates: true,
    });
  }

  async submit(market: MarketContext, write: ProductSubmitWrite): Promise<number> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    const at = toDate(write.now);
    const revisionNo =
      (await tx.certificationProductCertificationRevision.count({
        where: { marketId: market.marketId, productCertificationId: write.certificateId },
      })) + 1;
    try {
      await tx.certificationProductCertificationRevision.create({
        data: {
          ...base,
          id: write.revisionId,
          productCertificationId: write.certificateId,
          typeId: write.typeId,
          typeRevisionId: write.typeRevisionId,
          revisionNo,
          issuerId: write.issuerId,
          manufacturerName: write.manufacturerName,
          certificateNumberCiphertext: write.certificateNumberCiphertext,
          issueDate: toDay(write.issueDate),
          expiryDate: toDay(write.expiryDate),
          authorAccountId: write.authorAccountId,
          contentHash: write.contentHash,
          submittedByAccountId: write.submitterAccountId,
          submittedAt: at,
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === REVISION_NO_KEY) {
        throw new StaleAggregateError('product-certification', write.certificateId);
      }
      throw error;
    }
    await tx.certificationProductRevisionCoverage.createMany({
      data: write.coverage.map((entry) => ({
        ...base,
        id: this.ids.next<'ProductRevisionCoverage'>(),
        revisionId: write.revisionId,
        typeId: write.typeId,
        productId: entry.productId,
        productRevisionId: entry.productRevisionId,
        variantId: entry.variantId,
      })),
    });
    await tx.certificationProductRevisionEditor.createMany({
      data: write.editorAccountIds.map((accountId) => ({
        ...base,
        revisionId: write.revisionId,
        accountId,
      })),
    });
    const statusMoves = write.toStatus !== write.fromStatus;
    const { count } = await tx.certificationProductCertification.updateMany({
      where: {
        marketId: market.marketId,
        id: write.certificateId,
        status: write.fromStatus,
        pendingRevisionId: null,
      },
      data: {
        pendingRevisionId: write.revisionId,
        status: write.toStatus,
        ...(statusMoves ? { statusChangedAt: at } : {}),
      },
    });
    if (count !== 1) throw new StaleAggregateError('product-certification', write.certificateId);
    await tx.certificationProductCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        productCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: write.toStatus,
        revisionId: write.revisionId,
        actorKind: 'admin',
        actorAccountId: write.submitterAccountId,
        occurredAt: at,
      },
      select: { id: true },
    });
    return revisionNo;
  }

  async decide(market: MarketContext, write: ProductDecisionWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    const at = toDate(write.now);
    await tx.certificationProductRevisionDecision.create({
      data: {
        ...base,
        revisionId: write.revisionId,
        outcome: write.outcome,
        expiryBoundaryAt: write.expiryBoundaryAt === null ? null : toDate(write.expiryBoundaryAt),
        boundaryZone: write.boundaryZone,
        reasonCode: write.reasonCode,
        authorAccountId: write.authorAccountId,
        decidedByAccountId: write.deciderAccountId,
        decidedAt: at,
      },
      select: { revisionId: true },
    });
    const approved = write.outcome === 'approved';
    const { count } = await tx.certificationProductCertification.updateMany({
      where: {
        marketId: market.marketId,
        id: write.certificateId,
        status: write.fromStatus,
        pendingRevisionId: write.revisionId,
      },
      data: {
        pendingRevisionId: null,
        status: write.toStatus,
        ...(write.toStatus !== write.fromStatus ? { statusChangedAt: at } : {}),
        ...(approved
          ? {
              approvedRevisionId: write.revisionId,
              approvedBoundaryAt:
                write.expiryBoundaryAt === null ? null : toDate(write.expiryBoundaryAt),
            }
          : {}),
      },
    });
    if (count !== 1) throw new StaleAggregateError('product-certification', write.certificateId);
    if (approved) {
      // The approved content is another person's decision now: the next revision's editors start
      // afresh (a rejected revision's editors stay, so they never approve its resubmission).
      await tx.certificationProductDraftEditor.deleteMany({
        where: { marketId: market.marketId, productCertificationId: write.certificateId },
      });
    }
    await tx.certificationProductCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        productCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: write.toStatus,
        revisionId: write.revisionId,
        actorKind: 'admin',
        actorAccountId: write.deciderAccountId,
        reasonCode: write.reasonCode,
        occurredAt: at,
      },
      select: { id: true },
    });
  }

  async transition(market: MarketContext, write: ProductLifecycleWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    const at = toDate(write.now);
    if (write.withdrawn !== null) {
      // A system withdrawal: no decider (CHECK `(decided_by IS NULL) = (outcome = 'withdrawn')`).
      await tx.certificationProductRevisionDecision.create({
        data: {
          ...base,
          revisionId: write.withdrawn.revisionId,
          outcome: 'withdrawn',
          authorAccountId: write.withdrawn.authorAccountId,
          decidedByAccountId: null,
          decidedAt: at,
        },
        select: { revisionId: true },
      });
    }
    const { count } = await tx.certificationProductCertification.updateMany({
      where: {
        marketId: market.marketId,
        id: write.certificateId,
        status: write.fromStatus,
        approvedRevisionId: write.approvedRevisionId,
        ...(write.withdrawn === null ? {} : { pendingRevisionId: write.withdrawn.revisionId }),
      },
      data: {
        status: write.toStatus,
        statusChangedAt: at,
        ...(write.withdrawn === null ? {} : { pendingRevisionId: null }),
      },
    });
    if (count !== 1) throw new StaleAggregateError('product-certification', write.certificateId);
    await tx.certificationProductCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        productCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: write.toStatus,
        revisionId: write.approvedRevisionId,
        actorKind: write.actorAccountId === null ? 'system' : 'admin',
        actorAccountId: write.actorAccountId,
        reasonCode: write.reasonCode,
        noteCiphertext: write.noteCiphertext,
        occurredAt: at,
      },
      select: { id: true },
    });
  }

  async expiryCandidates(
    market: MarketContext,
    horizon: Temporal.Instant,
    after: ProductExpiryPage['last'],
    limit: number,
  ): Promise<ProductExpiryPage> {
    // A9 on `product_certifications` (partial index WHERE status = 'approved'); with a cursor the
    // redundant lower bound keeps it in the index condition, as the seller path's.
    const window =
      after === null
        ? { lt: toDate(horizon) }
        : { lt: toDate(horizon), gte: toDate(after.boundary) };
    const rows = await this.prisma.tx(market).certificationProductCertification.findMany({
      where: {
        marketId: market.marketId,
        status: 'approved',
        approvedBoundaryAt: window,
        ...(after === null
          ? {}
          : {
              OR: [
                { approvedBoundaryAt: { gt: toDate(after.boundary) } },
                { approvedBoundaryAt: toDate(after.boundary), id: { gt: after.certificateId } },
              ],
            }),
      },
      select: EXPIRY_SELECT,
      orderBy: [{ approvedBoundaryAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const warned = await this.#warned(
      market,
      rows.flatMap((row) => (row.approvedRevisionId === null ? [] : [row.approvedRevisionId])),
    );
    const candidates: ProductExpiryCandidate[] = [];
    for (const row of rows) {
      const candidate = expiryCandidateOf(row, warned);
      if (candidate !== null) candidates.push(candidate);
    }
    const lastRow = rows.at(-1);
    return {
      candidates,
      rawCount: rows.length,
      last:
        lastRow === undefined || lastRow.approvedBoundaryAt === null
          ? null
          : {
              boundary: toInstant(lastRow.approvedBoundaryAt),
              certificateId: lastRow.id as Id<'ProductCertification'>,
            },
      inconsistent: rows.length - candidates.length,
    };
  }

  async expiryCandidate(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
  ): Promise<ProductExpiryCandidate | null> {
    const row = await this.prisma.tx(market).certificationProductCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: EXPIRY_SELECT,
    });
    if (row === null || row.approvedRevisionId === null) return null;
    return expiryCandidateOf(row, await this.#warned(market, [row.approvedRevisionId]));
  }

  async recordWarning(
    market: MarketContext,
    write: Parameters<ProductCertificationRepository['recordWarning']>[1],
  ): Promise<void> {
    await this.prisma.tx(market).certificationExpiryWarning.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        versionKind: PRODUCT_REVISION_KIND,
        versionId: write.revisionId,
        thresholdDays: write.thresholdDays,
        createdAt: toDate(write.now),
      },
      select: { versionId: true },
    });
  }

  async history(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    limit: number,
  ): Promise<readonly ProductHistoryRow[]> {
    const rows = await this.prisma.tx(market).certificationProductCertificationHistory.findMany({
      where: { marketId: market.marketId, productCertificationId: certificateId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        revisionId: true,
        actorKind: true,
        actorAccountId: true,
        reasonCode: true,
        noteCiphertext: true,
        occurredAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus === null ? null : statusOf(row.fromStatus),
      toStatus: statusOf(row.toStatus),
      revisionId: row.revisionId,
      actorKind: row.actorKind === 'system' ? ('system' as const) : ('admin' as const),
      actorAccountId: row.actorAccountId,
      reasonCode: row.reasonCode,
      noteGiven: row.noteCiphertext !== null,
      occurredAt: toInstant(row.occurredAt),
    }));
  }

  /** The thresholds already marked per approved revision. */
  async #warned(
    market: MarketContext,
    revisionIds: readonly string[],
  ): Promise<ReadonlyMap<string, number[]>> {
    const warned = new Map<string, number[]>();
    if (revisionIds.length === 0) return warned;
    const rows = await this.prisma.tx(market).certificationExpiryWarning.findMany({
      where: {
        marketId: market.marketId,
        versionKind: PRODUCT_REVISION_KIND,
        versionId: { in: [...revisionIds] },
      },
      select: { versionId: true, thresholdDays: true },
    });
    for (const row of rows) {
      const list = warned.get(row.versionId) ?? [];
      list.push(row.thresholdDays);
      warned.set(row.versionId, list);
    }
    return warned;
  }

  async shareRegistryRows(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    issuerId: Id<'Issuer'> | null,
  ): Promise<RegistryRowsShared> {
    const [type] = await this.prisma.namedQuery(market, 'certification.share-type', { typeId });
    const issuer =
      issuerId === null
        ? undefined
        : (await this.prisma.namedQuery(market, 'certification.share-issuer', { issuerId }))[0];
    if (issuer !== undefined && !ISSUER_STATES.includes(issuer.state)) {
      throw new Error('certification issuer has an invalid state');
    }
    return {
      typeStatus: type === undefined ? null : type.status === 'active' ? 'active' : 'inactive',
      issuer:
        issuer === undefined
          ? null
          : {
              state: issuer.state as IssuerState,
              typeId: issuer.typeId as Id<'CertificationType'>,
            },
    };
  }

  async list(
    market: MarketContext,
    filter: Parameters<ProductCertificationRepository['list']>[1],
  ): Promise<readonly ProductCertificationSummary[]> {
    const rows = await this.prisma.tx(market).certificationProductCertification.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.status === null ? {} : { status: filter.status }),
        ...(filter.typeId === null ? {} : { typeId: filter.typeId }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      skip: filter.offset,
      select: {
        id: true,
        typeId: true,
        status: true,
        pendingRevisionId: true,
        approvedRevisionId: true,
        draftManufacturerName: true,
        lastChangedAt: true,
        version: true,
        _count: { select: { draftCoverage: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id as Id<'ProductCertification'>,
      typeId: row.typeId as Id<'CertificationType'>,
      status: statusOf(row.status),
      pendingRevisionId: row.pendingRevisionId,
      approvedRevisionId: row.approvedRevisionId,
      manufacturerName: row.draftManufacturerName,
      coverageEntries: row._count.draftCoverage,
      lastChangedAt: toInstant(row.lastChangedAt),
      version: row.version,
    }));
  }
}
