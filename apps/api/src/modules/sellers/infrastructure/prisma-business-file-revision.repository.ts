import { Temporal, err, ok } from '@mondapac/shared-kernel';
import type { ContentHash, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BusinessFileRevisionRepository,
  RevisionAddRefused,
} from '../application/ports/business-file-revision.repository';
import type { SealedRevision } from '../application/ports/revision-content-sealer';
import {
  REVISION_AUTHOR_KINDS,
  REVISION_KINDS,
  REVISION_STATUSES,
  WITHDRAW_CAUSES,
  type BusinessFileRevision,
  type RegisterSnapshotOutcome,
  type RevisionAuthorKind,
  type RevisionKind,
  type RevisionStatus,
  type WithdrawCause,
} from '../domain/business-file-revision';
import { identifierIndexKeyOf } from '../domain/business-identifier';
import { REGISTER_MISMATCHES, type RegisterMismatch } from '../domain/register-check';
import type { SealedRevisionContent } from '../domain/sealed';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const REGISTER_OUTCOMES = ['not-performed', 'active', 'not-found', 'cancelled', 'unavailable'];

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
export class StoredBusinessFileRevisionError extends Error {
  override readonly name = 'StoredBusinessFileRevisionError';
  constructor(column: string) {
    super(`sellers.business_file_revisions holds an invalid ${column}`);
  }
}

/** Every column except the content: a read of metadata never loads the ciphertext. */
const METADATA = {
  id: true,
  sellerId: true,
  kind: true,
  revisionNo: true,
  status: true,
  authorKind: true,
  authorAccountId: true,
  contentSchemaVersion: true,
  contentHash: true,
  identifierIndex: true,
  operatingTimezone: true,
  serviceAreaCode: true,
  addressTimezone: true,
  registerOutcome: true,
  registerMismatches: true,
  registerCheckedAt: true,
  createdAt: true,
  statusChangedAt: true,
  decidedAt: true,
  decidedByAccountId: true,
  identityDecisionId: true,
  rejectReasonCode: true,
  withdrawCause: true,
  withdrawnByKind: true,
  withdrawnAt: true,
} as const;

interface Row {
  readonly id: string;
  readonly sellerId: string;
  readonly kind: string;
  readonly revisionNo: number;
  readonly status: string;
  readonly authorKind: string;
  readonly authorAccountId: string;
  readonly contentSchemaVersion: number;
  readonly contentHash: string;
  readonly identifierIndex: Uint8Array | null;
  readonly operatingTimezone: string;
  readonly serviceAreaCode: string;
  readonly addressTimezone: string | null;
  readonly registerOutcome: string;
  readonly registerMismatches: string[];
  readonly registerCheckedAt: Date | null;
  readonly createdAt: Date;
  readonly statusChangedAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedByAccountId: string | null;
  readonly identityDecisionId: string | null;
  readonly rejectReasonCode: string | null;
  readonly withdrawCause: string | null;
  readonly withdrawnByKind: string | null;
  readonly withdrawnAt: Date | null;
}

const isOneOf = (list: readonly string[], value: string): boolean => list.includes(value);

function revisionOf(row: Row): BusinessFileRevision {
  if (!isOneOf(REVISION_KINDS, row.kind)) throw new StoredBusinessFileRevisionError('kind');
  if (!isOneOf(REVISION_STATUSES, row.status)) throw new StoredBusinessFileRevisionError('status');
  if (!isOneOf(REVISION_AUTHOR_KINDS, row.authorKind)) {
    throw new StoredBusinessFileRevisionError('author_kind');
  }
  if (!isOneOf(REGISTER_OUTCOMES, row.registerOutcome)) {
    throw new StoredBusinessFileRevisionError('register_outcome');
  }
  if (row.registerMismatches.some((flag) => !isOneOf(REGISTER_MISMATCHES, flag))) {
    throw new StoredBusinessFileRevisionError('register_mismatches');
  }
  if (!/^hmac-sha256:[0-9a-f]{64}$/.test(row.contentHash)) {
    throw new StoredBusinessFileRevisionError('content_hash');
  }
  let withdrawal: BusinessFileRevision['withdrawal'] = null;
  if (row.withdrawCause !== null) {
    if (
      !isOneOf(WITHDRAW_CAUSES, row.withdrawCause) ||
      row.withdrawnByKind === null ||
      !isOneOf(REVISION_AUTHOR_KINDS, row.withdrawnByKind) ||
      row.withdrawnAt === null
    ) {
      throw new StoredBusinessFileRevisionError('withdrawal');
    }
    withdrawal = {
      cause: row.withdrawCause as WithdrawCause,
      byKind: row.withdrawnByKind as RevisionAuthorKind,
      at: toInstant(row.withdrawnAt),
    };
  }
  return {
    id: row.id as Id<'BusinessFileRevision'>,
    sellerId: row.sellerId as Id<'Seller'>,
    kind: row.kind as RevisionKind,
    revisionNo: row.revisionNo,
    status: row.status as RevisionStatus,
    authorKind: row.authorKind as RevisionAuthorKind,
    authorAccountId: row.authorAccountId as Id<'Account'>,
    contentSchemaVersion: row.contentSchemaVersion,
    contentHash: row.contentHash as ContentHash,
    identifierIndex:
      row.identifierIndex === null
        ? null
        : identifierIndexKeyOf(new Uint8Array(row.identifierIndex)),
    operatingTimezone: row.operatingTimezone,
    serviceAreaCode: row.serviceAreaCode,
    addressTimezone: row.addressTimezone,
    register: {
      outcome: row.registerOutcome as RegisterSnapshotOutcome,
      mismatches: row.registerMismatches as RegisterMismatch[],
      checkedAt: row.registerCheckedAt === null ? null : toInstant(row.registerCheckedAt),
    },
    createdAt: toInstant(row.createdAt),
    statusChangedAt: toInstant(row.statusChangedAt),
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
    identityDecisionId: row.identityDecisionId,
    rejectReasonCode: row.rejectReasonCode,
    withdrawal,
  };
}

/**
 * {@link BusinessFileRevisionRepository} on `sellers.business_file_revisions` (data design 3.2).
 * Every statement goes through `PrismaService.tx(market)` with `marketId` at the top level of
 * `where`, and names the seller, so it never reaches another Market's or another seller's row. The
 * insert is `createMany … skipDuplicates` (`ON CONFLICT DO NOTHING`, which covers the partial
 * unique keys too): a refused insert leaves the unit's transaction usable, where a thrown unique
 * violation would abort it. Content is written once and is immutable by privilege.
 */
export class PrismaBusinessFileRevisionRepository implements BusinessFileRevisionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    revision: BusinessFileRevision,
    sealed: SealedRevision,
  ): Promise<Result<void, RevisionAddRefused>> {
    if (revision.status !== 'pending') {
      throw new RangeError('add: a new revision is pending');
    }
    if (revision.contentHash !== sealed.contentHash) {
      throw new RangeError('add: the revision hash is not the hash of the sealed content');
    }
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersBusinessFileRevision.createMany({
      data: [
        {
          id: revision.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: revision.sellerId,
          kind: revision.kind,
          revisionNo: revision.revisionNo,
          status: revision.status,
          authorKind: revision.authorKind,
          authorAccountId: revision.authorAccountId,
          contentCiphertext: sealed.ciphertext,
          contentSchemaVersion: revision.contentSchemaVersion,
          contentHash: revision.contentHash,
          identifierIndex:
            revision.identifierIndex === null ? null : Buffer.from(revision.identifierIndex),
          operatingTimezone: revision.operatingTimezone,
          serviceAreaCode: revision.serviceAreaCode,
          addressTimezone: revision.addressTimezone,
          registerOutcome: revision.register.outcome,
          registerMismatches: [...revision.register.mismatches],
          registerCheckedAt:
            revision.register.checkedAt === null ? null : toDate(revision.register.checkedAt),
          createdAt: toDate(revision.createdAt),
          statusChangedAt: toDate(revision.statusChangedAt),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return ok(undefined);

    // Nothing was written: name the key that was taken (the id, the number, else the pending one).
    const byId = await tx.sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, id: revision.id },
      select: { id: true },
    });
    if (byId !== null) return err({ code: 'revision.id-taken' });
    const byNumber = await tx.sellersBusinessFileRevision.findFirst({
      where: {
        marketId: market.marketId,
        sellerId: revision.sellerId,
        revisionNo: revision.revisionNo,
      },
      select: { id: true },
    });
    if (byNumber !== null) return err({ code: 'revision.number-taken' });
    return err({ code: 'revision.pending-exists' });
  }

  async findLatest(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<BusinessFileRevision | null> {
    const row = await this.prisma.tx(market).sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, sellerId },
      orderBy: { revisionNo: 'desc' },
      select: METADATA,
    });
    return row === null ? null : revisionOf(row);
  }

  async findPending(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<BusinessFileRevision | null> {
    const row = await this.prisma.tx(market).sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, sellerId, status: 'pending' },
      select: METADATA,
    });
    return row === null ? null : revisionOf(row);
  }

  async findApproved(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<BusinessFileRevision | null> {
    const tx = this.prisma.tx(market);
    // The pointer is the authority (data design 3.1); the revision is read by the id it names.
    const file = await tx.sellersSellerFile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { approvedRevisionId: true },
    });
    if (file === null || file.approvedRevisionId === null) return null;
    const row = await tx.sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, sellerId, id: file.approvedRevisionId },
      select: METADATA,
    });
    return row === null ? null : revisionOf(row);
  }

  async findById(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'BusinessFileRevision'>,
  ): Promise<BusinessFileRevision | null> {
    const row = await this.prisma.tx(market).sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, sellerId, id },
      select: METADATA,
    });
    return row === null ? null : revisionOf(row);
  }

  async readSealedContent(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'BusinessFileRevision'>,
  ): Promise<SealedRevisionContent | null> {
    const row = await this.prisma.tx(market).sellersBusinessFileRevision.findFirst({
      where: { marketId: market.marketId, sellerId, id },
      select: { contentCiphertext: true },
    });
    return row === null ? null : (row.contentCiphertext as SealedRevisionContent);
  }
}
