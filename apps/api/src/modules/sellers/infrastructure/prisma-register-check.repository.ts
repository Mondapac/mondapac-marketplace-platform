import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  RegisterCheckRepository,
  RegisterCheckWrite,
} from '../application/ports/register-check.repository';
import type { IdentifierIndexKey } from '../domain/business-identifier';
import {
  REGISTER_CHECKERS,
  REGISTER_MISMATCHES,
  REGISTER_OUTCOMES,
  type RegisterCheck,
  type RegisterCheckerKind,
  type RegisterMismatch,
  type RegisterOutcome,
} from '../domain/register-check';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
export class StoredRegisterCheckError extends Error {
  override readonly name = 'StoredRegisterCheckError';
  constructor(column: string) {
    super(`sellers.register_checks holds an invalid ${column}`);
  }
}

interface Row {
  readonly outcome: string;
  readonly mismatches: string[];
  readonly definiteNegativeAt: Date | null;
  readonly checkedAt: Date;
  readonly checkedByKind: string;
  readonly checkedByAccountId: string | null;
  readonly comparedFileVersion: number;
}

function checkOf(row: Row): RegisterCheck {
  // The CHECK keeps it >= 1; a value outside it is a fault of the data, never a version to trust.
  if (!Number.isSafeInteger(row.comparedFileVersion) || row.comparedFileVersion < 1) {
    throw new StoredRegisterCheckError('compared_file_version');
  }
  if (!(REGISTER_OUTCOMES as readonly string[]).includes(row.outcome)) {
    throw new StoredRegisterCheckError('outcome');
  }
  if (!(REGISTER_CHECKERS as readonly string[]).includes(row.checkedByKind)) {
    throw new StoredRegisterCheckError('checked_by_kind');
  }
  if (row.mismatches.some((flag) => !(REGISTER_MISMATCHES as readonly string[]).includes(flag))) {
    throw new StoredRegisterCheckError('mismatches');
  }
  return {
    outcome: row.outcome as RegisterOutcome,
    mismatches: row.mismatches as RegisterMismatch[],
    definiteNegativeAt: row.definiteNegativeAt === null ? null : toInstant(row.definiteNegativeAt),
    checkedAt: toInstant(row.checkedAt),
    checkedBy: {
      kind: row.checkedByKind as RegisterCheckerKind,
      accountId: row.checkedByAccountId as Id<'Account'> | null,
    },
    comparedFileVersion: row.comparedFileVersion,
  };
}

const COLUMNS = {
  outcome: true,
  mismatches: true,
  definiteNegativeAt: true,
  checkedAt: true,
  checkedByKind: true,
  checkedByAccountId: true,
  comparedFileVersion: true,
} as const;

/**
 * {@link RegisterCheckRepository} on `sellers.register_checks` (data design 3.4). Every statement
 * names the primary key `(market_id, seller_id, identifier_index)`, so it is a primary key probe
 * and never reaches another Market's or another seller's row.
 *
 * `record` keeps the sticky negative of `registerCheckAfter` under concurrent writers without a
 * read-modify-write, and makes the row **version-monotonic** (slice 5b; Hassan L1): the row is
 * inserted if absent (`ON CONFLICT DO NOTHING`), and every later write is one `UPDATE … WHERE
 * compared_file_version <= :new`, so a slower writer that compared an older version of the file
 * changes nothing, and in particular never clears `definite_negative_at` or replaces a newer
 * answer. A negative outcome is written by two statements that partition the row on its mark
 * (the first sets the mark with the outcome, the second leaves the mark alone), so the table's
 * CHECKs hold after each statement, also when the row was `active` before. Each statement is
 * atomic; a statement that matches no row writes nothing. The answer is the row as stored, which
 * is not the write when a newer version already holds the row.
 */
export class PrismaRegisterCheckRepository implements RegisterCheckRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
  ): Promise<RegisterCheck | null> {
    const row = await this.prisma.tx(market).sellersRegisterCheck.findUnique({
      where: {
        marketId: market.marketId,
        marketId_sellerId_identifierIndex: {
          marketId: market.marketId,
          sellerId,
          identifierIndex: Uint8Array.from(index),
        },
      },
      select: COLUMNS,
    });
    return row === null ? null : checkOf(row);
  }

  async record(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    index: IdentifierIndexKey,
    write: RegisterCheckWrite,
  ): Promise<RegisterCheck> {
    const transaction = this.prisma.tx(market);
    const identifierIndex = Uint8Array.from(index);
    const key = { marketId: market.marketId, sellerId, identifierIndex };
    const negative = write.outcome === 'not-found' || write.outcome === 'cancelled';
    const at = toDate(write.checkedAt);
    if (!Number.isSafeInteger(write.comparedFileVersion) || write.comparedFileVersion < 1) {
      throw new RangeError('record: the compared file version is a positive integer');
    }
    const answer = {
      outcome: write.outcome,
      mismatches: [...write.mismatches],
      checkedAt: at,
      checkedByKind: write.checkedBy.kind,
      checkedByAccountId: write.checkedBy.accountId,
      comparedFileVersion: write.comparedFileVersion,
    };
    // Only a row at this version or an older one is replaced (L1): the latest answer of the
    // newest version wins, whatever the order in which the writers commit.
    const notNewer = { ...key, comparedFileVersion: { lte: write.comparedFileVersion } };

    const { count: inserted } = await transaction.sellersRegisterCheck.createMany({
      data: [
        {
          ...key,
          tenantId: market.tenantId,
          ...answer,
          definiteNegativeAt: negative ? at : null,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted === 0) {
      if (negative) {
        // The first negative keeps its mark: a row without one gets this answer's instant ...
        await transaction.sellersRegisterCheck.updateMany({
          where: { ...notNewer, definiteNegativeAt: null },
          data: { ...answer, definiteNegativeAt: at },
        });
        // ... and a row that has one keeps it (a later negative only replaces the answer).
        await transaction.sellersRegisterCheck.updateMany({
          where: { ...notNewer, definiteNegativeAt: { not: null } },
          data: answer,
        });
      } else {
        await transaction.sellersRegisterCheck.updateMany({
          where: notNewer,
          data: {
            ...answer,
            // An active answer replaces a negative; an unavailable one leaves the mark alone.
            ...(write.outcome === 'active' ? { definiteNegativeAt: null } : {}),
          },
        });
      }
    }
    const stored = await transaction.sellersRegisterCheck.findUniqueOrThrow({
      where: { marketId: market.marketId, marketId_sellerId_identifierIndex: key },
      select: COLUMNS,
    });
    return checkOf(stored);
  }
}
