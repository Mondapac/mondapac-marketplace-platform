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
 * `record` keeps the sticky negative of `registerCheckAfter` under two concurrent writers without
 * a read-modify-write: it inserts the row if absent (`ON CONFLICT DO NOTHING`), sets the negative
 * mark only where it is still NULL, and then writes the latest answer, touching the mark again
 * only to clear it for an `active` answer. Each statement is atomic and the table's CHECKs hold
 * after each one (the mark is set before a negative outcome is written).
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
    const by = {
      checkedByKind: write.checkedBy.kind,
      checkedByAccountId: write.checkedBy.accountId,
      // Every write states the version it compared; the latest answer replaces the earlier one.
      comparedFileVersion: write.comparedFileVersion,
    };

    await transaction.sellersRegisterCheck.createMany({
      data: [
        {
          ...key,
          tenantId: market.tenantId,
          outcome: write.outcome,
          mismatches: [...write.mismatches],
          definiteNegativeAt: negative ? at : null,
          checkedAt: at,
          ...by,
        },
      ],
      skipDuplicates: true,
    });
    if (negative) {
      // The first negative stays: only a NULL mark is set.
      await transaction.sellersRegisterCheck.updateMany({
        where: { ...key, definiteNegativeAt: null },
        data: { definiteNegativeAt: at },
      });
    }
    await transaction.sellersRegisterCheck.updateMany({
      where: key,
      data: {
        outcome: write.outcome,
        mismatches: [...write.mismatches],
        checkedAt: at,
        ...by,
        // An active answer replaces a negative; nothing else touches the mark.
        ...(write.outcome === 'active' ? { definiteNegativeAt: null } : {}),
      },
    });
    const stored = await transaction.sellersRegisterCheck.findUniqueOrThrow({
      where: { marketId: market.marketId, marketId_sellerId_identifierIndex: key },
      select: COLUMNS,
    });
    return checkOf(stored);
  }
}
