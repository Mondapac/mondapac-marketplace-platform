import { Temporal } from '@mondapac/shared-kernel';
import type { Id, IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BalanceRecord,
  DueHold,
  ReconcileMismatch,
  DueLot,
  HistoryPage,
  HistoryRow,
  HoldRecord,
  InternalAccountKind,
  JournalKind,
  JournalRecord,
  NewJournal,
  NewLot,
  WalletAccountRecord,
  WalletRepository,
} from '../application/ports/wallet.repository';
import type { Lot, LotSource, Take } from '../domain/lots';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const toLot = (row: {
  readonly id: string;
  readonly source: string;
  readonly remainingMinor: bigint;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}): Lot => ({
  id: row.id as Id<'WalletLot'>,
  source: row.source as LotSource,
  remaining: row.remainingMinor,
  expiresAt: row.expiresAt === null ? null : toInstant(row.expiresAt),
  createdAt: toInstant(row.createdAt),
});

const toHold = (row: {
  readonly id: string;
  readonly walletAccountId: string;
  readonly orderId: string;
  readonly amountMinor: bigint;
  readonly status: string;
  readonly expiresAt: Date;
}): HoldRecord => ({
  id: row.id as Id<'WalletHold'>,
  walletAccountId: row.walletAccountId as Id<'WalletAccount'>,
  orderId: row.orderId as Id<'Order'>,
  amountMinor: row.amountMinor,
  status: row.status as HoldRecord['status'],
  expiresAt: toInstant(row.expiresAt),
});

/**
 * {@link WalletRepository} on the `wallet` tables, scoped by `marketId` in every `where`. The
 * balance row lock is a no-change update (as identity's credential lock): it is held until the
 * unit ends, so two operations on one wallet run one after the other.
 */
export class PrismaWalletRepository implements WalletRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async findWallet(market: MarketContext, customerAccountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).walletAccount.findFirst({
      where: { marketId: market.marketId, kind: 'credit_liability', customerAccountId },
    });
    return row === null
      ? null
      : ({
          id: row.id as Id<'WalletAccount'>,
          status: row.status as WalletAccountRecord['status'],
          currency: row.currency,
        } satisfies WalletAccountRecord);
  }

  async ensureWallet(
    market: MarketContext,
    input: {
      readonly newAccountId: Id<'WalletAccount'>;
      readonly customerAccountId: Id<'Account'>;
      readonly currency: string;
      readonly now: Temporal.Instant;
    },
  ) {
    const tx = this.prisma.tx(market);
    await tx.walletAccount.createMany({
      data: [
        {
          id: input.newAccountId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: 'credit_liability',
          customerAccountId: input.customerAccountId,
          currency: input.currency,
          status: 'active',
          createdAt: toDate(input.now),
        },
      ],
      skipDuplicates: true,
    });
    const wallet = await this.findWallet(market, input.customerAccountId);
    await tx.walletBalance.createMany({
      data: [
        {
          walletAccountId: wallet!.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          currency: input.currency,
          availableMinor: 0n,
          heldMinor: 0n,
          updatedAt: toDate(input.now),
        },
      ],
      skipDuplicates: true,
    });
    return wallet!;
  }

  async ensureInternalAccounts(
    market: MarketContext,
    kinds: readonly InternalAccountKind[],
    input: {
      readonly newId: () => Id<'WalletAccount'>;
      readonly currency: string;
      readonly now: Temporal.Instant;
    },
  ) {
    const tx = this.prisma.tx(market);
    await tx.walletAccount.createMany({
      data: kinds.map((kind) => ({
        id: input.newId(),
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind,
        customerAccountId: null,
        currency: input.currency,
        status: 'active',
        createdAt: toDate(input.now),
      })),
      skipDuplicates: true,
    });
    const rows = await tx.walletAccount.findMany({
      where: { marketId: market.marketId, kind: { in: [...kinds] }, customerAccountId: null },
    });
    return new Map(
      rows.map((row) => [row.kind as InternalAccountKind, row.id as Id<'WalletAccount'>]),
    );
  }

  async lockBalance(market: MarketContext, walletAccountId: Id<'WalletAccount'>) {
    const tx = this.prisma.tx(market);
    await tx.walletBalance.updateMany({
      where: { marketId: market.marketId, walletAccountId },
      data: { availableMinor: { increment: 0n } },
    });
    const row = await tx.walletBalance.findFirstOrThrow({
      where: { marketId: market.marketId, walletAccountId },
    });
    return {
      walletAccountId,
      availableMinor: row.availableMinor,
      heldMinor: row.heldMinor,
    } satisfies BalanceRecord;
  }

  async readBalance(market: MarketContext, walletAccountId: Id<'WalletAccount'>) {
    const row = await this.prisma.tx(market).walletBalance.findFirst({
      where: { marketId: market.marketId, walletAccountId },
    });
    return { availableMinor: row?.availableMinor ?? 0n, heldMinor: row?.heldMinor ?? 0n };
  }

  async saveBalance(market: MarketContext, balance: BalanceRecord, now: Temporal.Instant) {
    await this.prisma.tx(market).walletBalance.updateMany({
      where: { marketId: market.marketId, walletAccountId: balance.walletAccountId },
      data: {
        availableMinor: balance.availableMinor,
        heldMinor: balance.heldMinor,
        updatedAt: toDate(now),
      },
    });
  }

  async findJournal(market: MarketContext, idempotencyKey: string) {
    const row = await this.prisma.tx(market).walletJournal.findFirst({
      where: { marketId: market.marketId, idempotencyKey },
    });
    return row === null
      ? null
      : ({
          id: row.id as Id<'WalletJournal'>,
          fingerprint: row.fingerprint,
          result: row.result as Record<string, string>,
        } satisfies JournalRecord);
  }

  async hasJournals(market: MarketContext) {
    const row = await this.prisma.tx(market).walletJournal.findFirst({
      where: { marketId: market.marketId },
      select: { id: true },
    });
    return row !== null;
  }

  async appendJournal(market: MarketContext, journal: NewJournal) {
    const tx = this.prisma.tx(market);
    await tx.walletJournal.create({
      data: {
        id: journal.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind: journal.kind,
        idempotencyKey: journal.idempotencyKey,
        fingerprint: journal.fingerprint,
        actorKind: journal.actor.kind,
        actorId: journal.actor.id,
        reasonCode: journal.reasonCode,
        orderId: journal.orderId,
        walletAccountId: journal.walletAccountId,
        holdId: journal.holdId,
        lotId: journal.lotId,
        result: journal.result as Prisma.InputJsonObject,
        createdAt: toDate(journal.createdAt),
      },
    });
    await tx.walletPosting.createMany({
      data: journal.postings.map((posting) => ({
        id: this.ids.next<'WalletPosting'>(),
        marketId: market.marketId,
        tenantId: market.tenantId,
        journalId: journal.id,
        accountId: posting.accountId,
        amountMinor: posting.amountMinor,
        currency: journal.currency,
        walletAccountId: journal.walletAccountId,
      })),
    });
  }

  async createLot(market: MarketContext, lot: NewLot) {
    await this.prisma.tx(market).walletLot.create({
      data: {
        id: lot.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        walletAccountId: lot.walletAccountId,
        source: lot.source,
        journalId: lot.journalId,
        originalMinor: lot.amountMinor,
        remainingMinor: lot.amountMinor,
        currency: lot.currency,
        expiresAt: lot.expiresAt === null ? null : toDate(lot.expiresAt),
        createdAt: toDate(lot.createdAt),
      },
    });
  }

  async lotsWithCredit(market: MarketContext, walletAccountId: Id<'WalletAccount'>) {
    const rows = await this.prisma.tx(market).walletLot.findMany({
      where: { marketId: market.marketId, walletAccountId, remainingMinor: { gt: 0n } },
    });
    return rows.map(toLot);
  }

  async findLot(market: MarketContext, lotId: Id<'WalletLot'>) {
    const row = await this.prisma.tx(market).walletLot.findFirst({
      where: { marketId: market.marketId, id: lotId },
    });
    return row === null ? null : toLot(row);
  }

  async findLotWallet(market: MarketContext, lotId: Id<'WalletLot'>) {
    const row = await this.prisma.tx(market).walletLot.findFirst({
      where: { marketId: market.marketId, id: lotId },
      select: { walletAccountId: true },
    });
    return row === null ? null : (row.walletAccountId as Id<'WalletAccount'>);
  }

  async setLotRemaining(market: MarketContext, lotId: Id<'WalletLot'>, remainingMinor: bigint) {
    await this.prisma.tx(market).walletLot.updateMany({
      where: { marketId: market.marketId, id: lotId },
      data: { remainingMinor },
    });
  }

  async findHold(
    market: MarketContext,
    orderId: Id<'Order'>,
    walletAccountId?: Id<'WalletAccount'>,
  ) {
    const row = await this.prisma.tx(market).walletHold.findFirst({
      where: {
        marketId: market.marketId,
        orderId,
        ...(walletAccountId === undefined ? {} : { walletAccountId }),
      },
    });
    return row === null ? null : toHold(row);
  }

  async findHoldById(market: MarketContext, holdId: Id<'WalletHold'>) {
    const row = await this.prisma.tx(market).walletHold.findFirst({
      where: { marketId: market.marketId, id: holdId },
    });
    return row === null ? null : toHold(row);
  }

  async createHold(
    market: MarketContext,
    hold: HoldRecord & { readonly currency: string; readonly createdAt: Temporal.Instant },
    takes: readonly Take[],
  ) {
    const tx = this.prisma.tx(market);
    await tx.walletHold.create({
      data: {
        id: hold.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        walletAccountId: hold.walletAccountId,
        orderId: hold.orderId,
        amountMinor: hold.amountMinor,
        currency: hold.currency,
        status: 'held',
        expiresAt: toDate(hold.expiresAt),
        createdAt: toDate(hold.createdAt),
      },
    });
    await tx.walletHoldLot.createMany({
      data: takes.map((take) => ({
        holdId: hold.id,
        lotId: take.lotId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        amountMinor: take.amount,
      })),
    });
  }

  async holdLots(market: MarketContext, holdId: Id<'WalletHold'>) {
    const rows = await this.prisma.tx(market).walletHoldLot.findMany({
      where: { marketId: market.marketId, holdId },
    });
    return rows.map((row) => ({ lotId: row.lotId as Id<'WalletLot'>, amount: row.amountMinor }));
  }

  async settleHold(
    market: MarketContext,
    holdId: Id<'WalletHold'>,
    status: 'captured' | 'released' | 'expired',
    now: Temporal.Instant,
  ) {
    await this.prisma.tx(market).walletHold.updateMany({
      where: { marketId: market.marketId, id: holdId, status: 'held' },
      data: { status, resolvedAt: toDate(now) },
    });
  }

  async history(market: MarketContext, walletAccountId: Id<'WalletAccount'>, page: HistoryPage) {
    const tx = this.prisma.tx(market);
    const after = page.after;
    const journals = await tx.walletJournal.findMany({
      where: {
        marketId: market.marketId,
        walletAccountId,
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: toDate(after.createdAt) } },
                { createdAt: toDate(after.createdAt), id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    const legs = await tx.walletPosting.findMany({
      where: {
        marketId: market.marketId,
        accountId: walletAccountId,
        journalId: { in: journals.map((journal) => journal.id) },
      },
    });
    const byJournal = new Map(legs.map((leg) => [leg.journalId, leg.amountMinor]));
    return journals.map((journal): HistoryRow => ({
      journalId: journal.id as Id<'WalletJournal'>,
      kind: journal.kind as JournalKind,
      amountMinor: byJournal.get(journal.id) ?? 0n,
      reasonCode: journal.reasonCode,
      orderId: journal.orderId as Id<'Order'> | null,
      createdAt: toInstant(journal.createdAt),
    }));
  }

  async expiringLots(
    market: MarketContext,
    walletAccountId: Id<'WalletAccount'>,
    before: Temporal.Instant,
    after: Temporal.Instant,
    limit: number,
  ) {
    const rows = await this.prisma.tx(market).walletLot.findMany({
      where: {
        marketId: market.marketId,
        walletAccountId,
        source: 'promo',
        remainingMinor: { gt: 0n },
        expiresAt: { gt: toDate(after), lte: toDate(before) },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toLot);
  }

  async dueLots(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).walletLot.findMany({
      where: {
        marketId: market.marketId,
        source: 'promo',
        remainingMinor: { gt: 0n },
        expiresAt: { lte: toDate(now) },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((row): DueLot => ({
      lotId: row.id as Id<'WalletLot'>,
      walletAccountId: row.walletAccountId as Id<'WalletAccount'>,
    }));
  }

  async dueHolds(market: MarketContext, now: Temporal.Instant, limit: number) {
    const rows = await this.prisma.tx(market).walletHold.findMany({
      where: { marketId: market.marketId, status: 'held', expiresAt: { lte: toDate(now) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((row): DueHold => ({
      holdId: row.id as Id<'WalletHold'>,
      walletAccountId: row.walletAccountId as Id<'WalletAccount'>,
    }));
  }

  async reconcile(market: MarketContext) {
    const tx = this.prisma.tx(market);
    const marketId = market.marketId;
    const sums = <K extends string>(
      rows: readonly ({ [P in K]: string } & { _sum: Record<string, bigint | null> })[],
      key: K,
      field: string,
    ) => new Map(rows.map((row) => [row[key], row._sum[field] ?? 0n]));
    const [accounts, balances, postings, lots, held, unbalanced] = await Promise.all([
      tx.walletAccount.findMany({
        where: { marketId, kind: { in: ['credit_liability', 'holds'] } },
      }),
      tx.walletBalance.findMany({ where: { marketId } }),
      tx.walletPosting.groupBy({
        by: ['accountId'],
        where: { marketId },
        _sum: { amountMinor: true },
      }),
      tx.walletLot.groupBy({
        by: ['walletAccountId'],
        where: { marketId },
        _sum: { remainingMinor: true },
      }),
      tx.walletHold.groupBy({
        by: ['walletAccountId'],
        where: { marketId, status: 'held' },
        _sum: { amountMinor: true },
      }),
      tx.walletPosting.groupBy({
        by: ['journalId'],
        where: { marketId },
        having: { amountMinor: { _sum: { not: 0n } } },
        _sum: { amountMinor: true },
      }),
    ]);
    const postingSum = sums(postings, 'accountId', 'amountMinor');
    const lotSum = sums(lots, 'walletAccountId', 'remainingMinor');
    const heldSum = sums(held, 'walletAccountId', 'amountMinor');
    const balanceOf = new Map(balances.map((row) => [row.walletAccountId, row]));
    const out: ReconcileMismatch[] = [];
    for (const account of accounts) {
      if (account.kind === 'holds') {
        const total = [...heldSum.values()].reduce((a, b) => a + b, 0n);
        const actual = postingSum.get(account.id) ?? 0n;
        if (actual !== total) {
          out.push({
            check: 'holds-account-vs-held-holds',
            subject: account.id,
            expected: total,
            actual,
          });
        }
        continue;
      }
      const balance = balanceOf.get(account.id);
      const available = balance?.availableMinor ?? 0n;
      const heldMinor = balance?.heldMinor ?? 0n;
      const posted = postingSum.get(account.id) ?? 0n;
      const lotted = lotSum.get(account.id) ?? 0n;
      const holding = heldSum.get(account.id) ?? 0n;
      if (posted !== available) {
        out.push({
          check: 'postings-vs-available',
          subject: account.id,
          expected: available,
          actual: posted,
        });
      }
      if (lotted !== available) {
        out.push({
          check: 'lots-vs-available',
          subject: account.id,
          expected: available,
          actual: lotted,
        });
      }
      if (holding !== heldMinor) {
        out.push({
          check: 'held-holds-vs-held',
          subject: account.id,
          expected: heldMinor,
          actual: holding,
        });
      }
    }
    for (const row of unbalanced) {
      out.push({
        check: 'journal-unbalanced',
        subject: row.journalId,
        expected: 0n,
        actual: row._sum.amountMinor ?? 0n,
      });
    }
    return out;
  }
}
