import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  CertificateReviewRepository,
  CheckWrite,
  ConfirmationWrite,
  DecisionNotice,
  DecisionWrite,
  DuplicateHint,
  FullHistoryPage,
  FullHistoryRow,
  OtherSubmission,
  ReviewChannel,
  ReviewHistoryRow,
  ReviewIssuer,
  ReviewQueueEntry,
  ReviewSnapshot,
  ReviewSubmission,
  RevocationNotice,
  RevocationView,
  RevokeWrite,
  ScopeWrite,
  SellerOverviewRow,
  StoredConfirmation,
  StoredDecision,
  StoredReviewCheck,
  StoredScope,
} from '../application/ports/review.repository';
import type { CheckResult, DecisionOutcome } from '../domain/review';
import type { SubmissionKind } from '../domain/seller-certificate';
import type { VerificationMode } from '../domain/type-revision';
import type { IssuerState, SellerCertificationStatus } from '../domain/validity';
import {
  CERTIFICATE_INCLUDE,
  DOCUMENT_INCLUDE,
  fromDay,
  newestSubmissions,
  openIssuerRequestTypes,
  toCertificate,
  toDate,
  toDay,
  toDocument,
  toInstant,
} from './prisma-seller-certificate.repository';

const MAX_HINTS = 10;
const HISTORY_ROWS = 20;
const OTHER_SUBMISSIONS = 10;

const OTHER_SELECT = {
  id: true,
  submissionNo: true,
  kind: true,
  submittedAt: true,
  certificateNumberCiphertext: true,
  issueDate: true,
  expiryDate: true,
  issuer: { select: { displayName: true } },
  decision: {
    select: {
      outcome: true,
      reasonCode: true,
      reasonTextCiphertext: true,
      withdrawCause: true,
      expiryBoundaryAt: true,
      actorKind: true,
      decidedAt: true,
    },
  },
} as const;

const SUBMISSION_INCLUDE = {
  typeRevision: {
    select: {
      verificationMode: true,
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
    },
  },
  issuer: { include: { channels: { orderBy: { createdAt: 'asc' } } } },
  documents: {
    include: { document: { include: DOCUMENT_INCLUDE } },
    orderBy: { position: 'asc' },
  },
  decision: true,
  issuerConfirmations: true,
} as const;

/**
 * {@link CertificateReviewRepository} on the review tables of `certification` (data design 3.5,
 * 3.6, 3.10, 3.13, 3.16a, 3.17). Every method runs in the open unit of its caller. A write to the
 * root first moves its version with a guarded `updateMany` (which also takes the row lock), so a
 * stale caller throws {@link StaleAggregateError} before it writes anything else.
 */
export class PrismaCertificateReviewRepository implements CertificateReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async queue(market: MarketContext, limit: number): Promise<readonly ReviewQueueEntry[]> {
    const rows = await this.prisma.tx(market).certificationSellerCertification.findMany({
      where: { marketId: market.marketId, pendingSubmissionId: { not: null } },
      select: {
        id: true,
        version: true,
        sellerId: true,
        type: { select: { code: true } },
        pendingSubmission: {
          select: {
            id: true,
            submissionNo: true,
            kind: true,
            submittedAt: true,
            issuer: { select: { displayName: true } },
          },
        },
      },
      orderBy: [{ statusChangedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const entries: ReviewQueueEntry[] = [];
    for (const row of rows) {
      const pending = row.pendingSubmission;
      if (pending === null) continue;
      entries.push({
        certificateId: row.id as Id<'SellerCertification'>,
        version: row.version,
        sellerId: row.sellerId as Id<'Seller'>,
        typeCode: row.type.code,
        submissionId: pending.id as Id<'Submission'>,
        submissionNo: pending.submissionNo,
        kind: pending.kind as SubmissionKind,
        submittedAt: toInstant(pending.submittedAt),
        issuerName: pending.issuer?.displayName ?? null,
      });
    }
    return entries;
  }

  async snapshot(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    options: { readonly others?: boolean } = {},
  ): Promise<ReviewSnapshot | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      include: CERTIFICATE_INCLUDE,
    });
    if (row === null) return null;
    const certificate = toCertificate(
      row,
      await openIssuerRequestTypes(this.prisma, market, [row.sellerId]),
      await newestSubmissions(this.prisma, market, [row]),
    );
    const history = await tx.certificationSellerCertificationHistory.findMany({
      where: { marketId: market.marketId, sellerCertificationId: certificateId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_ROWS,
    });
    const historyRows: ReviewHistoryRow[] = history
      .map((h): ReviewHistoryRow => ({
        fromStatus: h.fromStatus as SellerCertificationStatus | null,
        toStatus: h.toStatus as SellerCertificationStatus,
        occurredAt: toInstant(h.occurredAt),
        actorKind: h.actorKind as ReviewHistoryRow['actorKind'],
        reasonCode: h.reasonCode,
      }))
      .reverse();

    // The pending submission, else the approved one, else the latest (to show a decision).
    const target = row.pendingSubmissionId ?? row.approvedSubmissionId;
    const submission = await tx.certificationSellerCertificationSubmission.findFirst({
      where:
        target === null
          ? { marketId: market.marketId, sellerCertificationId: certificateId }
          : { marketId: market.marketId, id: target },
      include: SUBMISSION_INCLUDE,
      orderBy: { submissionNo: 'desc' },
    });
    if (submission === null) {
      return { certificate, submission: null, pending: false, history: historyRows, others: [] };
    }
    const others =
      options.others === true
        ? await this.#others(
            market,
            certificateId,
            submission.id,
            row.approvedSubmissionId,
            row._count.submissions,
          )
        : [];

    const checkRows = await tx.certificationReviewCheck.findMany({
      where: { marketId: market.marketId, submissionId: submission.id },
      orderBy: [{ checkCode: 'asc' }, { recordedAt: 'desc' }, { id: 'desc' }],
      distinct: ['checkCode'],
    });
    const scopeRow = await tx.certificationScopeReading.findFirst({
      where: { marketId: market.marketId, submissionId: submission.id },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    const confirmation = submission.issuerConfirmations[0];
    const issuer: ReviewIssuer | null =
      submission.issuer === null
        ? null
        : {
            id: submission.issuer.id as Id<'Issuer'>,
            typeId: submission.issuer.typeId as Id<'CertificationType'>,
            displayName: submission.issuer.displayName,
            state: submission.issuer.state as IssuerState,
            channels: submission.issuer.channels.map((c): ReviewChannel => ({
              id: c.id as Id<'IssuerContactChannel'>,
              kind: c.kind as ReviewChannel['kind'],
              value: c.value,
              retired: c.retiredAt !== null,
            })),
          };
    const stored: ReviewSubmission = {
      id: submission.id as Id<'Submission'>,
      submissionNo: submission.submissionNo,
      kind: submission.kind as SubmissionKind,
      typeRevisionId: submission.typeRevisionId as Id<'CertificationTypeRevision'>,
      verificationMode: submission.typeRevision.verificationMode as VerificationMode,
      requiresIssuerRegistry: submission.typeRevision.requiresIssuerRegistry,
      requiresDocument: submission.typeRevision.requiresDocument,
      requiresExpiry: submission.typeRevision.requiresExpiry,
      issuer,
      certificateNumberCiphertext: submission.certificateNumberCiphertext,
      issueDate: fromDay(submission.issueDate),
      expiryDate: fromDay(submission.expiryDate),
      selfDeclared: submission.selfDeclared,
      selfDeclarationNoteCiphertext: submission.selfDeclarationNoteCiphertext,
      submittedZone: submission.submittedZone,
      submittedAt: toInstant(submission.submittedAt),
      documents: submission.documents.map((link) => toDocument(link.document, link.position)),
      checks: checkRows.map((c): StoredReviewCheck => ({
        id: c.id as Id<'ReviewCheck'>,
        code: c.checkCode,
        result: c.result as CheckResult,
        recordedAt: toInstant(c.recordedAt),
        recordedByAccountId: c.recordedByAccountId as Id<'Account'>,
      })),
      scope:
        scopeRow === null
          ? null
          : ({
              locationCiphertext: scopeRow.locationCiphertext,
              scopeCiphertext: scopeRow.scopeCiphertext,
              recordedAt: toInstant(scopeRow.recordedAt),
            } satisfies StoredScope),
      confirmation:
        confirmation === undefined
          ? null
          : ({
              issuerId: confirmation.issuerId as Id<'Issuer'>,
              channelId: confirmation.channelId as Id<'IssuerContactChannel'>,
              confirmedOn: fromDay(confirmation.confirmedOn)!,
              referenceCiphertext: confirmation.referenceCiphertext,
              recordedAt: toInstant(confirmation.recordedAt),
            } satisfies StoredConfirmation),
      decision:
        submission.decision === null
          ? null
          : ({
              outcome: submission.decision.outcome as StoredDecision['outcome'],
              reasonCode: submission.decision.reasonCode,
              reasonTextCiphertext: submission.decision.reasonTextCiphertext,
              decidedAt: toInstant(submission.decision.decidedAt),
              actorKind: submission.decision.actorKind as StoredDecision['actorKind'],
            } satisfies StoredDecision),
    };
    return {
      certificate,
      submission: stored,
      pending: row.pendingSubmissionId === submission.id,
      history: historyRows,
      others,
    };
  }

  /**
   * The record's other submissions, newest first on the (record, number) key, at most 10, and the
   * approved one when it is older than those: the reviewer sees the earlier submission, its reason
   * (AC 15) and, beside a renewal, the certificate in force. Only numbers up to `newestNo`, the
   * count the root read saw, so a submission made after that read (whose pointer the read could
   * not see) is never listed (Hassan L1).
   */
  async #others(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    shownId: string,
    approvedId: string | null,
    newestNo: number,
  ): Promise<readonly OtherSubmission[]> {
    const tx = this.prisma.tx(market);
    const rows = await tx.certificationSellerCertificationSubmission.findMany({
      where: {
        marketId: market.marketId,
        sellerCertificationId: certificateId,
        id: { not: shownId },
        submissionNo: { lte: newestNo },
      },
      select: OTHER_SELECT,
      orderBy: { submissionNo: 'desc' },
      take: OTHER_SUBMISSIONS,
    });
    if (approvedId !== null && approvedId !== shownId && !rows.some((r) => r.id === approvedId)) {
      const approved = await tx.certificationSellerCertificationSubmission.findFirst({
        where: { marketId: market.marketId, sellerCertificationId: certificateId, id: approvedId },
        select: OTHER_SELECT,
      });
      if (approved !== null) rows.push(approved);
    }
    return rows.map((r): OtherSubmission => ({
      id: r.id as Id<'Submission'>,
      submissionNo: r.submissionNo,
      kind: r.kind as SubmissionKind,
      submittedAt: toInstant(r.submittedAt),
      issuerName: r.issuer?.displayName ?? null,
      certificateNumberCiphertext: r.certificateNumberCiphertext,
      issueDate: fromDay(r.issueDate),
      expiryDate: fromDay(r.expiryDate),
      decision:
        r.decision === null
          ? null
          : {
              outcome: r.decision.outcome as StoredDecision['outcome'],
              reasonCode: r.decision.reasonCode,
              reasonTextCiphertext: r.decision.reasonTextCiphertext,
              decidedAt: toInstant(r.decision.decidedAt),
              actorKind: r.decision.actorKind as StoredDecision['actorKind'],
              withdrawCause: r.decision.withdrawCause as 'edited' | 'cancelled' | 'revoked' | null,
              expiryBoundaryAt:
                r.decision.expiryBoundaryAt === null
                  ? null
                  : toInstant(r.decision.expiryBoundaryAt),
            },
    }));
  }

  async duplicateHints(
    market: MarketContext,
    submissionId: Id<'Submission'>,
    sellerId: Id<'Seller'>,
  ): Promise<readonly DuplicateHint[]> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId };
    const hints: DuplicateHint[] = [];
    const seen = new Set<string>();
    const add = (hint: DuplicateHint): void => {
      const key = `${hint.kind}|${hint.certificateId}`;
      if (seen.has(key) || hints.length >= MAX_HINTS) return;
      seen.add(key);
      hints.push(hint);
    };

    const own = await tx.certificationCertificateNumberIndex.findFirst({
      where: { ...base, submissionId },
      select: { indexHmac: true },
    });
    if (own !== null) {
      const others = await tx.certificationCertificateNumberIndex.findMany({
        where: { ...base, indexHmac: Uint8Array.from(own.indexHmac), sellerId: { not: sellerId } },
        select: { sellerId: true, submission: { select: { sellerCertificationId: true } } },
        orderBy: { submissionId: 'asc' },
        take: MAX_HINTS,
      });
      for (const other of others) {
        add({
          kind: 'number',
          certificateId: other.submission.sellerCertificationId as Id<'SellerCertification'>,
          sellerId: other.sellerId as Id<'Seller'>,
        });
      }
    }

    const links = await tx.certificationSubmissionDocument.findMany({
      where: { ...base, submissionId },
      select: { documentId: true },
    });
    if (links.length > 0) {
      const ownFiles = await tx.certificationDocumentIndex.findMany({
        where: { ...base, documentId: { in: links.map((link) => link.documentId) } },
        select: { indexHmac: true },
      });
      if (ownFiles.length > 0) {
        const others = await tx.certificationDocumentIndex.findMany({
          where: {
            ...base,
            indexHmac: { in: ownFiles.map((file) => Uint8Array.from(file.indexHmac)) },
            sellerId: { not: sellerId },
          },
          select: {
            sellerId: true,
            document: {
              select: {
                submissionLinks: {
                  select: { submission: { select: { sellerCertificationId: true } } },
                  take: 1,
                },
              },
            },
          },
          orderBy: { documentId: 'asc' },
          take: MAX_HINTS * 2,
        });
        for (const other of others) {
          // A file that is still a draft is no certificate: only submitted files give a hint.
          const link = other.document.submissionLinks[0];
          if (link === undefined) continue;
          add({
            kind: 'file',
            certificateId: link.submission.sellerCertificationId as Id<'SellerCertification'>,
            sellerId: other.sellerId as Id<'Seller'>,
          });
        }
      }
    }
    return hints;
  }

  async recordCheck(market: MarketContext, write: CheckWrite): Promise<boolean> {
    if (!(await this.#sharePending(market, write.submissionId))) return false;
    await this.prisma.tx(market).certificationReviewCheck.create({
      data: {
        id: write.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        submissionId: write.submissionId,
        checkCode: write.code,
        result: write.result,
        recordedByAccountId: write.accountId,
        recordedAt: toDate(write.now),
      },
      select: { id: true },
    });
    return true;
  }

  async recordScope(market: MarketContext, write: ScopeWrite): Promise<boolean> {
    if (!(await this.#sharePending(market, write.submissionId))) return false;
    await this.prisma.tx(market).certificationScopeReading.create({
      data: {
        id: write.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        submissionId: write.submissionId,
        locationCiphertext: write.locationCiphertext,
        scopeCiphertext: write.scopeCiphertext,
        recordedByAccountId: write.accountId,
        recordedAt: toDate(write.now),
      },
      select: { id: true },
    });
    return true;
  }

  async recordConfirmation(
    market: MarketContext,
    write: ConfirmationWrite,
  ): Promise<'recorded' | 'exists'> {
    const tx = this.prisma.tx(market);
    await this.#moveVersion(market, write.certificateId, write.expectedVersion, write.now);
    const { count } = await tx.certificationIssuerConfirmation.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          submissionId: write.submissionId,
          issuerId: write.issuerId,
          channelId: write.channelId,
          confirmedOn: toDay(write.confirmedOn)!,
          referenceCiphertext: write.referenceCiphertext,
          confirmsNumber: true,
          confirmsHolder: true,
          recordedByAccountId: write.accountId,
          recordedAt: toDate(write.now),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? 'recorded' : 'exists';
  }

  async lockForDecision(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.#moveVersion(market, certificateId, expectedVersion, now);
  }

  async decide(market: MarketContext, write: DecisionWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    await tx.certificationSellerSubmissionDecision.create({
      data: {
        ...base,
        submissionId: write.submissionId,
        outcome: write.outcome,
        approvedZone: write.approvedZone,
        expiryBoundaryAt: write.expiryBoundaryAt === null ? null : toDate(write.expiryBoundaryAt),
        reasonCode: write.reasonCode,
        reasonTextCiphertext: write.reasonTextCiphertext,
        actorKind: 'admin',
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
        actorKind: 'admin',
        actorAccountId: write.accountId,
        reasonCode: write.reasonCode,
        occurredAt: toDate(write.decidedAt),
      },
      select: { id: true },
    });
    const approved = write.outcome === 'approved';
    await tx.certificationSellerCertification.updateMany({
      where: { marketId: market.marketId, id: write.certificateId },
      data: {
        status: write.toStatus,
        pendingSubmissionId: null,
        ...(approved
          ? {
              approvedSubmissionId: write.submissionId,
              approvedBoundaryAt:
                write.expiryBoundaryAt === null ? null : toDate(write.expiryBoundaryAt),
            }
          : {}),
        ...(write.toStatus === write.fromStatus
          ? {}
          : { statusChangedAt: toDate(write.decidedAt) }),
      },
    });
  }

  async revocationView(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<RevocationView | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      include: CERTIFICATE_INCLUDE,
    });
    if (row === null) return null;
    const certificate = toCertificate(
      row,
      await openIssuerRequestTypes(this.prisma, market, [row.sellerId]),
      await newestSubmissions(this.prisma, market, [row]),
    );
    if (row.approvedSubmissionId === null) return { certificate, approved: null };
    const approved = await tx.certificationSellerCertificationSubmission.findFirst({
      where: {
        marketId: market.marketId,
        sellerCertificationId: certificateId,
        id: row.approvedSubmissionId,
      },
      select: { id: true, typeRevisionId: true },
    });
    return {
      certificate,
      approved:
        approved === null
          ? null
          : {
              submissionId: approved.id as Id<'Submission'>,
              typeRevisionId: approved.typeRevisionId as Id<'CertificationTypeRevision'>,
            },
    };
  }

  async revoke(market: MarketContext, write: RevokeWrite): Promise<void> {
    const tx = this.prisma.tx(market);
    const base = { marketId: market.marketId, tenantId: market.tenantId };
    const at = toDate(write.revokedAt);
    if (write.withdrawnSubmissionId !== null) {
      // The pending renewal or correction leaves the queue with the revoke (design 3.2 row 2).
      await tx.certificationSellerSubmissionDecision.create({
        data: {
          ...base,
          submissionId: write.withdrawnSubmissionId,
          outcome: 'withdrawn',
          withdrawCause: 'revoked',
          actorKind: 'admin',
          actorAccountId: write.accountId,
          decidedAt: at,
        },
        select: { submissionId: true },
      });
    }
    await tx.certificationSellerCertificationHistory.create({
      data: {
        ...base,
        id: write.historyId,
        sellerCertificationId: write.certificateId,
        fromStatus: write.fromStatus,
        toStatus: 'revoked',
        submissionId: write.approvedSubmissionId,
        actorKind: 'admin',
        actorAccountId: write.accountId,
        reasonCode: write.reasonCode,
        noteCiphertext: write.noteCiphertext,
        occurredAt: at,
      },
      select: { id: true },
    });
    // The approved pointer stays (it names what was revoked); the status alone ends validity.
    const { count } = await tx.certificationSellerCertification.updateMany({
      where: {
        marketId: market.marketId,
        id: write.certificateId,
        status: write.fromStatus,
        approvedSubmissionId: write.approvedSubmissionId,
        pendingSubmissionId: write.withdrawnSubmissionId,
      },
      data: { status: 'revoked', pendingSubmissionId: null, statusChangedAt: at },
    });
    // The version lock was taken first, so the record cannot have moved; refuse loudly if it did.
    if (count !== 1) throw new StaleAggregateError('seller-certification', write.certificateId);
  }

  async revocationNotice(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<RevocationNotice | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: {
        sellerId: true,
        status: true,
        approvedSubmissionId: true,
        type: { select: { code: true } },
      },
    });
    if (row === null) return null;
    const revoked = await tx.certificationSellerCertificationHistory.findFirst({
      where: {
        marketId: market.marketId,
        sellerCertificationId: certificateId,
        toStatus: 'revoked',
      },
      select: { reasonCode: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    });
    return {
      sellerId: row.sellerId as Id<'Seller'>,
      typeCode: row.type.code,
      status: row.status as SellerCertificationStatus,
      approvedSubmissionId: row.approvedSubmissionId as Id<'Submission'> | null,
      reasonCode: revoked?.reasonCode ?? null,
    };
  }

  async historyPage(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    page: { readonly beforeId: Id<'CertificationHistory'> | null; readonly limit: number },
  ): Promise<FullHistoryPage | null> {
    const tx = this.prisma.tx(market);
    const root = await tx.certificationSellerCertification.findFirst({
      where: { marketId: market.marketId, id: certificateId },
      select: { sellerId: true },
    });
    if (root === null) return null;
    const where = { marketId: market.marketId, sellerCertificationId: certificateId };
    let older = {};
    if (page.beforeId !== null) {
      const cursor = await tx.certificationSellerCertificationHistory.findFirst({
        where: { ...where, id: page.beforeId },
        select: { id: true, occurredAt: true },
      });
      if (cursor === null) return null;
      older = {
        OR: [
          { occurredAt: { lt: cursor.occurredAt } },
          { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
        ],
      };
    }
    // Served by (market_id, seller_certification_id, occurred_at) (data design A13).
    const rows = await tx.certificationSellerCertificationHistory.findMany({
      where: { ...where, ...older },
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        submissionId: true,
        actorKind: true,
        actorAccountId: true,
        reasonCode: true,
        noteCiphertext: true,
        occurredAt: true,
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
    });
    return {
      sellerId: root.sellerId as Id<'Seller'>,
      more: rows.length > page.limit,
      rows: rows.slice(0, page.limit).map((h): FullHistoryRow => ({
        id: h.id as Id<'CertificationHistory'>,
        fromStatus: h.fromStatus as SellerCertificationStatus | null,
        toStatus: h.toStatus as SellerCertificationStatus,
        submissionId: h.submissionId as Id<'Submission'> | null,
        actorKind: h.actorKind as FullHistoryRow['actorKind'],
        actorAccountId: h.actorAccountId as Id<'Account'> | null,
        reasonCode: h.reasonCode,
        noteCiphertext: h.noteCiphertext,
        occurredAt: toInstant(h.occurredAt),
      })),
    };
  }

  async overview(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    now: Temporal.Instant,
  ): Promise<readonly SellerOverviewRow[]> {
    const rows = await this.prisma.tx(market).certificationSellerCertification.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      select: {
        sellerId: true,
        status: true,
        pendingSubmissionId: true,
        approvedSubmissionId: true,
        approvedBoundaryAt: true,
        type: { select: { code: true } },
        approvedSubmission: { select: { issuer: { select: { state: true } } } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const bySeller = new Map<string, { valid: Set<string>; pending: Set<string> }>();
    for (const row of rows) {
      const entry = bySeller.get(row.sellerId) ?? { valid: new Set(), pending: new Set() };
      bySeller.set(row.sellerId, entry);
      if (row.pendingSubmissionId !== null) entry.pending.add(row.type.code);
      const boundary = row.approvedBoundaryAt === null ? null : toInstant(row.approvedBoundaryAt);
      const live = boundary === null || Temporal.Instant.compare(boundary, now) > 0;
      if (
        row.status === 'approved' &&
        row.approvedSubmissionId !== null &&
        live &&
        row.approvedSubmission?.issuer?.state !== 'derecognised'
      ) {
        entry.valid.add(row.type.code);
      }
    }
    return [...bySeller].map(([sellerId, { valid, pending }]) => ({
      sellerId: sellerId as Id<'Seller'>,
      validTypeCodes: [...valid].sort(),
      pendingTypeCodes: [...pending].sort(),
    }));
  }

  async decisionNotice(
    market: MarketContext,
    submissionId: Id<'Submission'>,
  ): Promise<DecisionNotice | null> {
    const row = await this.prisma.tx(market).certificationSellerSubmissionDecision.findFirst({
      where: { marketId: market.marketId, submissionId },
      select: {
        outcome: true,
        reasonCode: true,
        submission: {
          select: {
            sellerId: true,
            sellerCertificationId: true,
            certificate: { select: { type: { select: { code: true } } } },
          },
        },
      },
    });
    if (row === null) return null;
    return {
      certificateId: row.submission.sellerCertificationId as Id<'SellerCertification'>,
      sellerId: row.submission.sellerId as Id<'Seller'>,
      typeCode: row.submission.certificate.type.code,
      outcome: row.outcome as DecisionOutcome | 'withdrawn',
      reasonCode: row.reasonCode,
    };
  }

  async eraseIndexRows(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, sellerId };
    const numbers = await tx.certificationCertificateNumberIndex.deleteMany({ where });
    const files = await tx.certificationDocumentIndex.deleteMany({ where });
    return numbers.count + files.count;
  }

  /** Moves the root's version by one when it is still `expected`; the row lock follows. */
  /**
   * `FOR SHARE` on the root while it still points at the submission as pending: the platform's
   * named statement `certification.share-pending-submission` (no raw SQL in the module).
   */
  async #sharePending(market: MarketContext, submissionId: Id<'Submission'>): Promise<boolean> {
    const rows = await this.prisma.namedQuery(market, 'certification.share-pending-submission', {
      submissionId,
    });
    return rows.length > 0;
  }

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
