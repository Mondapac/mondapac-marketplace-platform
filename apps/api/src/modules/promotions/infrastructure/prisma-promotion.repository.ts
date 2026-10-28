import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  LockContendedError,
  type LiveScope,
  type PromotionFilter,
  type PromotionRepository,
  type UsageRecord,
} from '../application/ports/promotion.repository';
import type {
  CreatableType,
  Funding,
  PausedBy,
  PromotionRecord,
  PromotionStatus,
} from '../domain/promotion';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly name: string;
  readonly funding: string;
  readonly platformSplitBps: number | null;
  readonly ownerSellerId: string | null;
  readonly combinable: boolean;
  readonly code: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly testMode: boolean;
  readonly specialCampaign: boolean;
  readonly priorApproved: boolean;
  readonly pausedBy: string | null;
  readonly currency: string;
  readonly rewardKind: string;
  readonly rewardBps: number | null;
  readonly rewardAmountMinor: bigint | null;
  readonly capMinor: bigint | null;
  readonly maxPerOrderMinor: bigint | null;
  readonly maxTotalUses: number | null;
  readonly maxUsesPerCustomer: number | null;
  readonly budgetMinor: bigint | null;
  readonly minSpendMinor: bigint | null;
  readonly createdByAccountId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly buyQty: number | null;
  readonly getQty: number | null;
  readonly groupQty: number | null;
  readonly maxRepeatsPerOrder: number | null;
  readonly flashUnitLimit: number | null;
  readonly flashTimeZone: string | null;
  readonly targets: readonly { readonly kind: string; readonly value: string }[];
  readonly tiers: readonly {
    readonly thresholdMinor: bigint;
    readonly rewardKind: string;
    readonly rewardBps: number | null;
    readonly rewardAmountMinor: bigint | null;
  }[];
  readonly bundleItems: readonly { readonly productId: string; readonly quantity: number }[];
}

/** Every read loads a promotion with its targets, tiers and bundle items. */
const WITH_CHILDREN = { targets: true, tiers: true, bundleItems: true } as const;

function toRecord(row: Row): PromotionRecord {
  const targets = (kind: string) =>
    row.targets
      .filter((target) => target.kind === kind)
      .map((target) => target.value)
      .sort();
  return {
    id: row.id as Id<'Promotion'>,
    type: row.type as CreatableType,
    status: row.status as PromotionStatus,
    name: row.name,
    funding: row.funding as Funding,
    platformSplitBps: row.platformSplitBps,
    ownerSellerId: row.ownerSellerId as Id<'Seller'> | null,
    combinable: row.combinable,
    code: row.code,
    startsAt: fromDate(row.startsAt),
    endsAt: row.endsAt === null ? null : fromDate(row.endsAt),
    testMode: row.testMode,
    specialCampaign: row.specialCampaign,
    priorApproved: row.priorApproved,
    pausedBy: row.pausedBy as PausedBy | null,
    currency: row.currency,
    reward:
      row.rewardKind === 'PERCENT'
        ? { kind: 'PERCENT', bps: row.rewardBps ?? 0 }
        : { kind: 'FIXED', amount: row.rewardAmountMinor ?? 0n },
    capMinor: row.capMinor,
    maxPerOrderMinor: row.maxPerOrderMinor,
    maxTotalUses: row.maxTotalUses,
    maxUsesPerCustomer: row.maxUsesPerCustomer,
    budgetMinor: row.budgetMinor,
    minSpendMinor: row.minSpendMinor,
    productIds: targets('PRODUCT') as Id<'Product'>[],
    sellerIds: targets('SELLER') as Id<'Seller'>[],
    zones: targets('ZONE'),
    tiers: [...row.tiers]
      .sort((a, b) =>
        a.thresholdMinor < b.thresholdMinor ? -1 : a.thresholdMinor > b.thresholdMinor ? 1 : 0,
      )
      .map((tier) => ({
        thresholdMinor: tier.thresholdMinor,
        reward:
          tier.rewardKind === 'PERCENT'
            ? { kind: 'PERCENT' as const, bps: tier.rewardBps ?? 0 }
            : { kind: 'FIXED' as const, amount: tier.rewardAmountMinor ?? 0n },
      })),
    buyQty: row.buyQty,
    getQty: row.getQty,
    groupQty: row.groupQty,
    bundleItems: [...row.bundleItems]
      .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0))
      .map((item) => ({ productId: item.productId as Id<'Product'>, quantity: item.quantity })),
    maxRepeatsPerOrder: row.maxRepeatsPerOrder,
    flashUnitLimit: row.flashUnitLimit,
    flashTimeZone: row.flashTimeZone,
    createdByAccountId: row.createdByAccountId as Id<'Account'>,
    createdAt: fromDate(row.createdAt),
    updatedAt: fromDate(row.updatedAt),
  };
}

/** The columns an edit may change (the rest of a promotion never changes). */
const editable = (record: PromotionRecord) => ({
  name: record.name,
  status: record.status,
  platformSplitBps: record.platformSplitBps,
  combinable: record.combinable,
  startsAt: toDate(record.startsAt),
  endsAt: record.endsAt === null ? null : toDate(record.endsAt),
  testMode: record.testMode,
  specialCampaign: record.specialCampaign,
  priorApproved: record.priorApproved,
  pausedBy: record.pausedBy,
  rewardKind: record.reward.kind,
  rewardBps: record.reward.kind === 'PERCENT' ? record.reward.bps : null,
  rewardAmountMinor: record.reward.kind === 'FIXED' ? record.reward.amount : null,
  capMinor: record.capMinor,
  maxPerOrderMinor: record.maxPerOrderMinor,
  maxTotalUses: record.maxTotalUses,
  maxUsesPerCustomer: record.maxUsesPerCustomer,
  budgetMinor: record.budgetMinor,
  minSpendMinor: record.minSpendMinor,
  buyQty: record.buyQty,
  getQty: record.getQty,
  groupQty: record.groupQty,
  maxRepeatsPerOrder: record.maxRepeatsPerOrder,
  flashUnitLimit: record.flashUnitLimit,
  flashTimeZone: record.flashTimeZone,
  updatedAt: toDate(record.updatedAt),
});

const tierRows = (market: MarketContext, record: PromotionRecord) =>
  record.tiers.map((tier) => ({
    marketId: market.marketId,
    tenantId: market.tenantId,
    promotionId: record.id,
    thresholdMinor: tier.thresholdMinor,
    rewardKind: tier.reward.kind,
    rewardBps: tier.reward.kind === 'PERCENT' ? tier.reward.bps : null,
    rewardAmountMinor: tier.reward.kind === 'FIXED' ? tier.reward.amount : null,
  }));

const bundleRows = (market: MarketContext, record: PromotionRecord) =>
  record.bundleItems.map((item) => ({
    marketId: market.marketId,
    tenantId: market.tenantId,
    promotionId: record.id,
    productId: item.productId,
    quantity: item.quantity,
  }));

const targetRows = (market: MarketContext, record: PromotionRecord) =>
  [
    ...record.productIds.map((value) => ({ kind: 'PRODUCT', value })),
    ...record.sellerIds.map((value) => ({ kind: 'SELLER', value })),
    ...record.zones.map((value) => ({ kind: 'ZONE', value })),
  ].map((target) => ({
    marketId: market.marketId,
    tenantId: market.tenantId,
    promotionId: record.id,
    ...target,
  }));

/** {@link PromotionRepository} on `promotions.promotions` and its children, scoped by `marketId`. */
export class PrismaPromotionRepository implements PromotionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    market: MarketContext,
    record: PromotionRecord,
  ): Promise<'inserted' | 'duplicate-code'> {
    const tx = this.prisma.tx(market);
    // ON CONFLICT DO NOTHING: a taken code does not abort the unit's transaction.
    const created = await tx.promotionsPromotion.createMany({
      data: [
        {
          ...editable(record),
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          type: record.type,
          funding: record.funding,
          ownerSellerId: record.ownerSellerId,
          code: record.code,
          currency: record.currency,
          createdByAccountId: record.createdByAccountId,
          createdAt: toDate(record.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return 'duplicate-code';
    await tx.promotionsUsage.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        promotionId: record.id,
        usesCount: 0,
        spentMinor: 0n,
        sellerShareMinor: 0n,
        platformShareMinor: 0n,
        updatedAt: toDate(record.createdAt),
      },
    });
    const targets = targetRows(market, record);
    if (targets.length > 0) await tx.promotionsTarget.createMany({ data: targets });
    const tiers = tierRows(market, record);
    if (tiers.length > 0) await tx.promotionsTier.createMany({ data: tiers });
    const items = bundleRows(market, record);
    if (items.length > 0) await tx.promotionsBundleItem.createMany({ data: items });
    return 'inserted';
  }

  async update(market: MarketContext, record: PromotionRecord): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.promotionsPromotion.updateMany({
      where: { marketId: market.marketId, id: record.id },
      data: editable(record),
    });
    await tx.promotionsTarget.deleteMany({
      where: { marketId: market.marketId, promotionId: record.id },
    });
    const targets = targetRows(market, record);
    if (targets.length > 0) await tx.promotionsTarget.createMany({ data: targets });
    // The tiers and the bundle items are replaced as sets too.
    await tx.promotionsTier.deleteMany({
      where: { marketId: market.marketId, promotionId: record.id },
    });
    const tiers = tierRows(market, record);
    if (tiers.length > 0) await tx.promotionsTier.createMany({ data: tiers });
    await tx.promotionsBundleItem.deleteMany({
      where: { marketId: market.marketId, promotionId: record.id },
    });
    const items = bundleRows(market, record);
    if (items.length > 0) await tx.promotionsBundleItem.createMany({ data: items });
  }

  async find(market: MarketContext, id: Id<'Promotion'>): Promise<PromotionRecord | null> {
    const row = await this.prisma.tx(market).promotionsPromotion.findFirst({
      where: { marketId: market.marketId, id },
      include: WITH_CHILDREN,
    });
    return row === null ? null : toRecord(row);
  }

  async findForUpdate(market: MarketContext, id: Id<'Promotion'>): Promise<PromotionRecord | null> {
    const tx = this.prisma.tx(market);
    // The client sends no raw SQL, so the lock is a row update that changes nothing: it takes the
    // row lock until the unit ends. Every change moves `updated_at`, so a row that moved since it
    // was read matches no row; read it again and lock the new version.
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await tx.promotionsPromotion.findFirst({
        where: { marketId: market.marketId, id },
        include: WITH_CHILDREN,
      });
      if (row === null) return null;
      const locked = await tx.promotionsPromotion.updateMany({
        where: { marketId: market.marketId, id, updatedAt: row.updatedAt },
        data: { updatedAt: row.updatedAt },
      });
      if (locked.count !== 1) continue;
      // The row is ours now: read it again, so what is returned is what the lock protects.
      const held = await tx.promotionsPromotion.findFirst({
        where: { marketId: market.marketId, id },
        include: WITH_CHILDREN,
      });
      return held === null ? null : toRecord(held);
    }
    throw new LockContendedError('promotions.promotion');
  }

  async findMany(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<readonly PromotionRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).promotionsPromotion.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      include: WITH_CHILDREN,
    });
    return rows.map(toRecord);
  }

  async list(market: MarketContext, filter: PromotionFilter): Promise<readonly PromotionRecord[]> {
    const rows = await this.prisma.tx(market).promotionsPromotion.findMany({
      where: {
        marketId: market.marketId,
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.ownerSellerId === undefined ? {} : { ownerSellerId: filter.ownerSellerId }),
      },
      include: WITH_CHILDREN,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
    });
    return rows.map(toRecord);
  }

  async listLive(
    market: MarketContext,
    now: Temporal.Instant,
    scope: LiveScope,
  ): Promise<readonly PromotionRecord[]> {
    const at = toDate(now);
    const rows = await this.prisma.tx(market).promotionsPromotion.findMany({
      where: {
        marketId: market.marketId,
        status: 'ACTIVE',
        startsAt: { lte: at },
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gt: at } }] },
          // The platform's promotions, and those of a seller that is in the cart.
          { OR: [{ ownerSellerId: null }, { ownerSellerId: { in: [...scope.sellerIds] } }] },
          // Aimed at any product, or at one of the cart's.
          {
            OR: [
              { targets: { none: { kind: 'PRODUCT' } } },
              { targets: { some: { kind: 'PRODUCT', value: { in: [...scope.productIds] } } } },
            ],
          },
        ],
      },
      include: WITH_CHILDREN,
      orderBy: { id: 'asc' },
    });
    return rows.map(toRecord);
  }

  countCounting(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    now: Temporal.Instant,
  ): Promise<number> {
    const at = toDate(now);
    return this.prisma.tx(market).promotionsPromotion.count({
      where: {
        marketId: market.marketId,
        ownerSellerId: sellerId,
        status: { in: ['ACTIVE', 'PENDING_APPROVAL'] },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
    });
  }

  async usageOf(
    market: MarketContext,
    ids: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, UsageRecord>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.tx(market).promotionsUsage.findMany({
      where: { marketId: market.marketId, promotionId: { in: [...ids] } },
    });
    return new Map(
      rows.map((row) => [
        row.promotionId as Id<'Promotion'>,
        {
          usesCount: row.usesCount,
          spentMinor: row.spentMinor,
          sellerShareMinor: row.sellerShareMinor,
          platformShareMinor: row.platformShareMinor,
        },
      ]),
    );
  }
}
