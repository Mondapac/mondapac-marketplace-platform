import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ReferralCodeRecord,
  ReferralRepository,
} from '../application/ports/credit.repository';
import type { ReferralRecord, ReferralRejectReason, ReferralStatus } from '../domain/credit';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly promotionId: string;
  readonly referrerAccountId: string;
  readonly refereeAccountId: string;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly qualifyingOrderId: string | null;
  readonly qualifyingSellerOrderId: string | null;
}

const toRecord = (row: Row): ReferralRecord => ({
  id: row.id as Id<'Referral'>,
  promotionId: row.promotionId as Id<'Promotion'>,
  referrerAccountId: row.referrerAccountId as Id<'Account'>,
  refereeAccountId: row.refereeAccountId as Id<'Account'>,
  status: row.status as ReferralStatus,
  rejectReason: row.rejectReason as ReferralRejectReason | null,
  createdAt: fromDate(row.createdAt),
  expiresAt: fromDate(row.expiresAt),
  decidedAt: row.decidedAt === null ? null : fromDate(row.decidedAt),
  qualifyingOrderId: row.qualifyingOrderId as Id<'Order'> | null,
  qualifyingSellerOrderId: row.qualifyingSellerOrderId as Id<'SellerOrder'> | null,
});

/** {@link ReferralRepository} on `promotions.referral_codes` and `promotions.referrals`. */
export class PrismaReferralRepository implements ReferralRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findCode(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<ReferralCodeRecord | null> {
    const row = await this.prisma.tx(market).promotionsReferralCode.findFirst({
      where: { marketId: market.marketId, accountId },
    });
    return row === null
      ? null
      : { accountId, codeHash: row.codeHash, createdAt: fromDate(row.createdAt) };
  }

  async findCodeByHash(
    market: MarketContext,
    codeHash: string,
  ): Promise<ReferralCodeRecord | null> {
    const row = await this.prisma.tx(market).promotionsReferralCode.findFirst({
      where: { marketId: market.marketId, codeHash },
    });
    return row === null
      ? null
      : {
          accountId: row.accountId as Id<'Account'>,
          codeHash,
          createdAt: fromDate(row.createdAt),
        };
  }

  async insertCode(
    market: MarketContext,
    record: ReferralCodeRecord,
  ): Promise<'inserted' | 'duplicate'> {
    const created = await this.prisma.tx(market).promotionsReferralCode.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: record.accountId,
          codeHash: record.codeHash,
          createdAt: toDate(record.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'duplicate';
  }

  async findQualifiedBySellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<ReferralRecord | null> {
    const row = await this.prisma.tx(market).promotionsReferral.findFirst({
      where: {
        marketId: market.marketId,
        qualifyingSellerOrderId: sellerOrderId,
        status: 'QUALIFIED',
      },
    });
    return row === null ? null : toRecord(row);
  }

  async findByReferee(
    market: MarketContext,
    refereeAccountId: Id<'Account'>,
  ): Promise<ReferralRecord | null> {
    const row = await this.prisma.tx(market).promotionsReferral.findFirst({
      where: { marketId: market.marketId, refereeAccountId },
    });
    return row === null ? null : toRecord(row);
  }

  async insert(market: MarketContext, record: ReferralRecord): Promise<'inserted' | 'duplicate'> {
    const created = await this.prisma.tx(market).promotionsReferral.createMany({
      data: [
        {
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          promotionId: record.promotionId,
          referrerAccountId: record.referrerAccountId,
          refereeAccountId: record.refereeAccountId,
          status: record.status,
          rejectReason: record.rejectReason,
          createdAt: toDate(record.createdAt),
          expiresAt: toDate(record.expiresAt),
          decidedAt: record.decidedAt === null ? null : toDate(record.decidedAt),
          qualifyingOrderId: record.qualifyingOrderId,
          qualifyingSellerOrderId: record.qualifyingSellerOrderId,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? 'inserted' : 'duplicate';
  }

  async decide(
    market: MarketContext,
    id: Id<'Referral'>,
    decision:
      | {
          readonly status: 'QUALIFIED';
          readonly orderId: Id<'Order'>;
          readonly sellerOrderId: Id<'SellerOrder'>;
        }
      | { readonly status: 'REJECTED'; readonly reason: ReferralRejectReason }
      | { readonly status: 'EXPIRED' },
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).promotionsReferral.updateMany({
      where: { marketId: market.marketId, id, status: 'PENDING' },
      data: {
        status: decision.status,
        decidedAt: toDate(at),
        ...(decision.status === 'QUALIFIED'
          ? {
              qualifyingOrderId: decision.orderId,
              qualifyingSellerOrderId: decision.sellerOrderId,
            }
          : {}),
        ...(decision.status === 'REJECTED' ? { rejectReason: decision.reason } : {}),
      },
    });
    return updated.count === 1;
  }

  countByReferrer(
    market: MarketContext,
    referrerAccountId: Id<'Account'>,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
    notExpiredAt?: Temporal.Instant,
  ): Promise<number> {
    return this.prisma.tx(market).promotionsReferral.count({
      where: {
        marketId: market.marketId,
        referrerAccountId,
        promotionId,
        status,
        ...(notExpiredAt === undefined ? {} : { expiresAt: { gt: toDate(notExpiredAt) } }),
      },
    });
  }

  countByPromotion(
    market: MarketContext,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
  ): Promise<number> {
    return this.prisma.tx(market).promotionsReferral.count({
      where: { marketId: market.marketId, promotionId, status },
    });
  }

  async listByReferrer(
    market: MarketContext,
    referrerAccountId: Id<'Account'>,
    limit: number,
  ): Promise<readonly ReferralRecord[]> {
    const rows = await this.prisma.tx(market).promotionsReferral.findMany({
      where: { marketId: market.marketId, referrerAccountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }
}
