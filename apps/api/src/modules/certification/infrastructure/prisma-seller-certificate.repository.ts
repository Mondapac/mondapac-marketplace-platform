import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  NewCertificate,
  NewDocument,
  SellerCertificateRepository,
  StoredCertificate,
  StoredDocument,
  StoredDraft,
  SubmitWrite,
  WithdrawWrite,
} from '../application/ports/seller-certificate.repository';
import type { SubmissionKind } from '../domain/seller-certificate';
import type { IssuerState, SellerCertificationStatus } from '../domain/validity';

/** The partial unique index of data design 3.4: one open certificate per seller and type (T1). */
const UNIQUE_OPEN_CERTIFICATE = 'seller_certifications_market_id_seller_id_type_id_open_key';

export const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
export const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A `date` column: the calendar day as written, with no zone. */
export const toDay = (date: Temporal.PlainDate | null): Date | null =>
  date === null ? null : new Date(`${date.toString()}T00:00:00.000Z`);
export const fromDay = (date: Date | null): Temporal.PlainDate | null =>
  date === null
    ? null
    : Temporal.PlainDate.from({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      });

export const CERTIFICATE_INCLUDE = {
  type: { select: { code: true } },
  pendingSubmission: { select: { kind: true } },
  approvedSubmission: { select: { issuer: { select: { state: true } } } },
  _count: { select: { submissions: true } },
} as const;

export const DOCUMENT_INCLUDE = { _count: { select: { submissionLinks: true } } } as const;

export interface CertificateRow {
  id: string;
  sellerId: string;
  typeId: string;
  status: string;
  pendingSubmissionId: string | null;
  approvedSubmissionId: string | null;
  approvedBoundaryAt: Date | null;
  statusChangedAt: Date;
  lastChangedAt: Date;
  createdAt: Date;
  version: number;
  draftIssuerId: string | null;
  draftCertificateNumberCiphertext: string | null;
  draftIssueDate: Date | null;
  draftExpiryDate: Date | null;
  draftSelfDeclared: boolean | null;
  draftSelfDeclarationNoteCiphertext: string | null;
  type: { code: string };
  pendingSubmission: { kind: string } | null;
  approvedSubmission: { issuer: { state: string } | null } | null;
  _count: { submissions: number };
}

/**
 * The types for which the seller has an open request (design 3.3 `draft-issuer-not-listed`), on the
 * partial index `issuer_requests_market_id_seller_id_type_id_open_idx`. Ids only.
 */
export async function openIssuerRequestTypes(
  prisma: PrismaService,
  market: MarketContext,
  sellerIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (sellerIds.length === 0) return new Set();
  const rows = await prisma.tx(market).certificationIssuerRequest.findMany({
    where: { marketId: market.marketId, sellerId: { in: [...sellerIds] }, state: 'open' },
    select: { sellerId: true, typeId: true },
    distinct: ['sellerId', 'typeId'],
  });
  return new Set(rows.map((row) => `${row.sellerId}|${row.typeId}`));
}

/**
 * A stored certificate. `openRequests` is the answer of {@link openIssuerRequestTypes} for the
 * certificate's seller: whether a "my issuer is not listed" request of its type is open.
 */
export function toCertificate(
  row: CertificateRow,
  openRequests: ReadonlySet<string>,
): StoredCertificate {
  const draft: StoredDraft = {
    issuerId: row.draftIssuerId as Id<'Issuer'> | null,
    certificateNumberCiphertext: row.draftCertificateNumberCiphertext,
    issueDate: fromDay(row.draftIssueDate),
    expiryDate: fromDay(row.draftExpiryDate),
    selfDeclared: row.draftSelfDeclared,
    selfDeclarationNoteCiphertext: row.draftSelfDeclarationNoteCiphertext,
  };
  return {
    id: row.id as Id<'SellerCertification'>,
    sellerId: row.sellerId as Id<'Seller'>,
    typeId: row.typeId as Id<'CertificationType'>,
    typeCode: row.type.code,
    status: row.status as SellerCertificationStatus,
    pendingSubmissionId: row.pendingSubmissionId as Id<'Submission'> | null,
    pendingKind: (row.pendingSubmission?.kind ?? null) as SubmissionKind | null,
    approvedSubmissionId: row.approvedSubmissionId as Id<'Submission'> | null,
    approvedBoundaryAt: row.approvedBoundaryAt === null ? null : toInstant(row.approvedBoundaryAt),
    approvedIssuerState: (row.approvedSubmission?.issuer?.state ?? null) as IssuerState | null,
    issuerRequestOpen: openRequests.has(`${row.sellerId}|${row.typeId}`),
    submissionCount: row._count.submissions,
    statusChangedAt: toInstant(row.statusChangedAt),
    lastChangedAt: toInstant(row.lastChangedAt),
    createdAt: toInstant(row.createdAt),
    version: row.version,
    draft,
  };
}

export interface DocumentRow {
  id: string;
  mediaType: string | null;
  byteSize: bigint;
  pageCount: number | null;
  createdAt: Date;
  objectKey: string;
  dataKeyEnvelope: string;
  cleanSha256: Uint8Array | null;
  purpose: string;
  _count: { submissionLinks: number };
}

export function toDocument(row: DocumentRow, position: number): StoredDocument {
  if (row.cleanSha256 === null || row.mediaType === null) {
    // Only clean files are ever linked (the link trigger): anything else is a fault.
    throw new Error('certification document: a linked file is not clean');
  }
  return {
    id: row.id as Id<'UploadedDocument'>,
    position,
    mediaType: row.mediaType as StoredDocument['mediaType'],
    byteSize: Number(row.byteSize),
    pageCount: row.pageCount,
    createdAt: toInstant(row.createdAt),
    objectKey: row.objectKey,
    dataKeyEnvelope: row.dataKeyEnvelope,
    cleanSha256: Buffer.from(row.cleanSha256),
    submitted: row._count.submissionLinks > 0,
    purpose: row.purpose,
  };
}

/**
 * {@link SellerCertificateRepository} on the certificate tables of `certification` (data design
 * 3.4 to 3.13). Every method runs in the open unit of its caller. A write to the root first moves
 * its version with a guarded `updateMany` (which also takes the row lock), so a stale caller
 * throws {@link StaleAggregateError} before it writes anything else.
 */
export class PrismaSellerCertificateRepository implements SellerCertificateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    certificate: NewCertificate,
  ): Promise<'certificate.exists' | null> {
    const tx = this.prisma.tx(market);
    try {
      await tx.certificationSellerCertification.create({
        data: {
          id: certificate.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: certificate.sellerId,
          typeId: certificate.typeId,
          status: 'draft',
          statusChangedAt: toDate(certificate.now),
          lastChangedAt: toDate(certificate.now),
          version: 1,
          createdAt: toDate(certificate.now),
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.prisma.violatedConstraint(error) === UNIQUE_OPEN_CERTIFICATE) {
        return 'certificate.exists';
      }
      throw error;
    }
    return null;
  }

  async findOwn(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerCertification'>,
  ): Promise<StoredCertificate | null> {
    const row = await this.prisma.tx(market).certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, sellerId, id },
      include: CERTIFICATE_INCLUDE,
    });
    if (row === null) return null;
    return toCertificate(row, await openIssuerRequestTypes(this.prisma, market, [sellerId]));
  }

  async listOwn(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: { readonly afterId: Id<'SellerCertification'> | null; readonly limit: number },
  ): Promise<readonly StoredCertificate[]> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, sellerId };
    let where: Record<string, unknown> = base;
    if (page.afterId !== null) {
      const cursor = await tx.certificationSellerCertification.findFirst({
        where: { ...base, id: page.afterId },
        select: { createdAt: true },
      });
      if (cursor === null) return [];
      where = {
        ...base,
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: page.afterId } },
        ],
      };
    }
    const rows = await tx.certificationSellerCertification.findMany({
      where,
      include: CERTIFICATE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    const open = await openIssuerRequestTypes(this.prisma, market, [sellerId]);
    return rows.map((row) => toCertificate(row, open));
  }

  async saveDraft(
    market: MarketContext,
    id: Id<'SellerCertification'>,
    expectedVersion: number,
    draft: StoredDraft,
    now: Temporal.Instant,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id, version: expectedVersion },
      data: {
        draftIssuerId: draft.issuerId,
        draftCertificateNumberCiphertext: draft.certificateNumberCiphertext,
        draftIssueDate: toDay(draft.issueDate),
        draftExpiryDate: toDay(draft.expiryDate),
        draftSelfDeclared: draft.selfDeclared,
        draftSelfDeclarationNoteCiphertext: draft.selfDeclarationNoteCiphertext,
        lastChangedAt: toDate(now),
        version: expectedVersion + 1,
      },
    });
    if (count !== 1) throw new StaleAggregateError('seller-certification', id);
  }

  async deleteNeverSubmitted(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerCertification'>,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const row = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, sellerId, id },
      select: { _count: { select: { submissions: true, history: true } } },
    });
    if (row === null || row._count.submissions > 0 || row._count.history > 0) return false;
    const links = await tx.certificationSellerDraftDocument.findMany({
      where: { marketId: market.marketId, sellerCertificationId: id },
      select: { documentId: true },
    });
    await tx.certificationSellerDraftDocument.deleteMany({
      where: { marketId: market.marketId, sellerCertificationId: id },
    });
    if (links.length > 0) {
      await tx.certificationDocumentIndex.deleteMany({
        where: {
          marketId: market.marketId,
          documentId: { in: links.map((link) => link.documentId) },
        },
      });
      await tx.certificationUploadedDocument.deleteMany({
        where: {
          marketId: market.marketId,
          ownerSellerId: sellerId,
          id: { in: links.map((link) => link.documentId) },
        },
      });
    }
    const { count } = await tx.certificationSellerCertification.deleteMany({
      where: { marketId: market.marketId, sellerId, id },
    });
    return count === 1;
  }

  async listDocuments(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<readonly StoredDocument[]> {
    const rows = await this.prisma.tx(market).certificationSellerDraftDocument.findMany({
      where: { marketId: market.marketId, sellerCertificationId: certificateId },
      include: { document: { include: DOCUMENT_INCLUDE } },
      orderBy: { position: 'asc' },
    });
    return rows.map((row) => toDocument(row.document, row.position));
  }

  async findDocumentForRead(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
  ): Promise<StoredDocument | null> {
    const tx = this.prisma.tx(market);
    const owned = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, sellerId, id: certificateId },
      select: { id: true },
    });
    if (owned === null) return null;
    const row = await tx.certificationUploadedDocument.findFirst({
      where: {
        marketId: market.marketId,
        id: documentId,
        ownerSellerId: sellerId,
        OR: [
          { draftLinks: { some: { sellerCertificationId: certificateId } } },
          { submissionLinks: { some: { submission: { sellerCertificationId: certificateId } } } },
        ],
      },
      include: {
        ...DOCUMENT_INCLUDE,
        draftLinks: { select: { position: true }, take: 1 },
        submissionLinks: { select: { position: true }, take: 1 },
      },
    });
    if (row === null) return null;
    const position = row.draftLinks[0]?.position ?? row.submissionLinks[0]?.position ?? 1;
    return toDocument(row, position);
  }

  async addDocument(market: MarketContext, document: NewDocument): Promise<void> {
    const tx = this.prisma.tx(market);
    await this.#moveVersion(market, document.certificateId, document.expectedVersion, document.now);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.certificationUploadedDocument.create({
      data: {
        ...base,
        id: document.id,
        ownerSellerId: document.sellerId,
        purpose: 'seller-certificate',
        typeId: document.typeId,
        state: 'clean',
        mediaType: document.mediaType,
        byteSize: BigInt(document.byteSize),
        pageCount: document.pageCount,
        dataKeyEnvelope: document.dataKeyEnvelope,
        objectKey: document.objectKey,
        cleanSha256: Uint8Array.from(document.cleanSha256),
        version: 1,
        createdAt: toDate(document.now),
      },
      select: { id: true },
    });
    await tx.certificationDocumentIndex.create({
      data: {
        ...base,
        documentId: document.id,
        sellerId: document.sellerId,
        indexHmac: Uint8Array.from(document.indexHmac),
      },
      select: { documentId: true },
    });
    await tx.certificationSellerDraftDocument.create({
      data: {
        ...base,
        sellerCertificationId: document.certificateId,
        typeId: document.typeId,
        sellerId: document.sellerId,
        documentId: document.id,
        position: document.position,
      },
      select: { documentId: true },
    });
  }

  async removeDocument(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<'deleted' | 'unlinked' | 'missing'> {
    const tx = this.prisma.tx(market);
    const link = await tx.certificationSellerDraftDocument.findFirst({
      where: { marketId: market.marketId, sellerCertificationId: certificateId, documentId },
      select: { documentId: true },
    });
    if (link === null) return 'missing';
    await this.#moveVersion(market, certificateId, expectedVersion, now);
    await tx.certificationSellerDraftDocument.deleteMany({
      where: { marketId: market.marketId, sellerCertificationId: certificateId, documentId },
    });
    const held = await tx.certificationSubmissionDocument.count({
      where: { marketId: market.marketId, documentId },
    });
    if (held > 0) return 'unlinked';
    await tx.certificationDocumentIndex.deleteMany({
      where: { marketId: market.marketId, documentId },
    });
    await tx.certificationUploadedDocument.deleteMany({
      where: { marketId: market.marketId, id: documentId },
    });
    return 'deleted';
  }

  async submit(market: MarketContext, write: SubmitWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await this.#moveVersion(market, write.certificateId, write.expectedVersion, write.submittedAt);
    await tx.certificationSellerCertificationSubmission.create({
      data: {
        ...base,
        id: write.submissionId,
        sellerCertificationId: write.certificateId,
        sellerId: write.sellerId,
        typeId: write.typeId,
        typeRevisionId: write.typeRevisionId,
        submissionNo: write.submissionNo,
        kind: write.kind,
        issuerId: write.issuerId,
        certificateNumberCiphertext: write.certificateNumberCiphertext,
        issueDate: toDay(write.issueDate),
        expiryDate: toDay(write.expiryDate),
        selfDeclared: write.selfDeclared,
        selfDeclarationNoteCiphertext: write.selfDeclarationNoteCiphertext,
        contentSchemaVersion: write.contentSchemaVersion,
        contentHash: write.contentHash,
        submittedZone: write.submittedZone,
        submittedAt: toDate(write.submittedAt),
        submittedByAccountId: write.submittedByAccountId,
      },
      select: { id: true },
    });
    if (write.numberIndexHmac !== null) {
      await tx.certificationCertificateNumberIndex.create({
        data: {
          ...base,
          submissionId: write.submissionId,
          sellerId: write.sellerId,
          indexHmac: Uint8Array.from(write.numberIndexHmac),
        },
        select: { submissionId: true },
      });
    }
    if (write.documentIds.length > 0) {
      await tx.certificationSubmissionDocument.createMany({
        data: write.documentIds.map((documentId, index) => ({
          ...base,
          submissionId: write.submissionId,
          typeId: write.typeId,
          sellerId: write.sellerId,
          documentId,
          position: index + 1,
        })),
      });
    }
    await tx.certificationSellerCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        sellerCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: write.toStatus,
        submissionId: write.submissionId,
        actorKind: 'seller',
        actorAccountId: write.submittedByAccountId,
        occurredAt: toDate(write.submittedAt),
      },
      select: { id: true },
    });
    await tx.certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id: write.certificateId },
      data: {
        status: write.toStatus,
        pendingSubmissionId: write.submissionId,
        ...(write.toStatus === write.fromStatus
          ? {}
          : { statusChangedAt: toDate(write.submittedAt) }),
      },
    });
  }

  async withdraw(market: MarketContext, write: WithdrawWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await this.#moveVersion(market, write.certificateId, write.expectedVersion, write.decidedAt);
    await tx.certificationSellerSubmissionDecision.create({
      data: {
        ...base,
        submissionId: write.submissionId,
        outcome: 'withdrawn',
        withdrawCause: write.cause,
        actorKind: 'seller',
        actorAccountId: write.accountId,
        decidedAt: toDate(write.decidedAt),
      },
      select: { submissionId: true },
    });
    await tx.certificationSellerCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        sellerCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: write.toStatus,
        submissionId: write.submissionId,
        actorKind: 'seller',
        actorAccountId: write.accountId,
        reasonCode: write.cause,
        occurredAt: toDate(write.decidedAt),
      },
      select: { id: true },
    });
    await tx.certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id: write.certificateId },
      data: {
        status: write.toStatus,
        pendingSubmissionId: null,
        ...(write.toStatus === write.fromStatus
          ? {}
          : { statusChangedAt: toDate(write.decidedAt) }),
      },
    });
  }

  async reserveQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    bytes: number,
    limit: number,
    now: Temporal.Instant,
  ): Promise<boolean> {
    if (bytes > limit) return false;
    const tx = this.prisma.tx(market);
    await tx.certificationSellerDraftQuota.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          draftBytes: 0n,
          updatedAt: toDate(now),
        },
      ],
      skipDuplicates: true,
    });
    const { count } = await tx.certificationSellerDraftQuota.updateMany({
      where: {
        marketId: market.marketId,
        sellerId,
        draftBytes: { lte: BigInt(limit - bytes) },
      },
      data: { draftBytes: { increment: BigInt(bytes) }, updatedAt: toDate(now) },
    });
    return count === 1;
  }

  async releaseQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    bytes: number,
    now: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const { count } = await tx.certificationSellerDraftQuota.updateMany({
      where: { marketId: market.marketId, sellerId, draftBytes: { gte: BigInt(bytes) } },
      data: { draftBytes: { decrement: BigInt(bytes) }, updatedAt: toDate(now) },
    });
    if (count === 1) return;
    await tx.certificationSellerDraftQuota.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { draftBytes: 0n, updatedAt: toDate(now) },
    });
  }

  /** Moves the root's version by one when it is still `expected`; the row lock follows. */
  async #moveVersion(
    market: MarketContext,
    id: Id<'SellerCertification'>,
    expected: number,
    now: Temporal.Instant,
  ): Promise<void> {
    const { count } = await this.prisma.tx(market).certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id, version: expected },
      data: { version: expected + 1, lastChangedAt: toDate(now) },
    });
    if (count !== 1) throw new StaleAggregateError('seller-certification', id);
  }
}
