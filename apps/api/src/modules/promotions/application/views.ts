import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { Reward } from '../domain/calculation/types';
import type {
  BundleItemDraft,
  Funding,
  PausedBy,
  PromotionRecord,
  PromotionStatus,
  CreatableType,
  TierDraft,
} from '../domain/promotion';
import type { UsageRecord } from './ports/promotion.repository';

// What the use cases answer. Amounts stay bigint here; the presentation layer writes them as digit
// strings (ADR-0007). A Viewer's view carries usage counts only.

interface Common {
  readonly id: Id<'Promotion'>;
  readonly type: CreatableType;
  readonly status: PromotionStatus;
  readonly name: string;
  readonly funding: Funding;
  readonly ownerSellerId: Id<'Seller'> | null;
  readonly combinable: boolean;
  readonly code: string | null;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant | null;
  readonly testMode: boolean;
  readonly reward: Reward;
  readonly currency: string;
  readonly minSpendMinor: bigint | null;
  readonly maxTotalUses: number | null;
  readonly maxUsesPerCustomer: number | null;
  readonly productIds: readonly Id<'Product'>[];
  readonly sellerIds: readonly Id<'Seller'>[];
  readonly zones: readonly string[];
  /** TIERED_CART: lowest threshold first; empty for any other type. */
  readonly tiers: readonly TierDraft[];
  readonly buyQty: number | null;
  readonly getQty: number | null;
  readonly groupQty: number | null;
  readonly bundleItems: readonly BundleItemDraft[];
  readonly maxRepeatsPerOrder: number | null;
  /** FLASH_SALE: the limit of units and the zone the window was written in. */
  readonly flash: { readonly unitLimit: number; readonly timeZone: string } | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** The Viewer's list row: how often a promotion was used, and no cost, budget or share. */
export interface PromotionUsageView extends Common {
  readonly usesCount: number;
}

/** The full view for `promotions.promotion.manage`: terms, budget and the money used. */
export interface PromotionView extends Common {
  readonly platformSplitBps: number | null;
  readonly specialCampaign: boolean;
  readonly priorApproved: boolean;
  readonly pausedBy: PausedBy | null;
  readonly capMinor: bigint | null;
  readonly maxPerOrderMinor: bigint | null;
  readonly budgetMinor: bigint | null;
  readonly usage: UsageRecord;
}

/** A seller's view of its own promotion: its own money, never the platform's share. */
export interface OwnPromotionView extends Common {
  readonly pausedBy: PausedBy | null;
  readonly capMinor: bigint | null;
  readonly maxPerOrderMinor: bigint | null;
  readonly budgetMinor: bigint | null;
  readonly usesCount: number;
  readonly spentMinor: bigint;
}

const ZERO_USAGE: UsageRecord = {
  usesCount: 0,
  spentMinor: 0n,
  sellerShareMinor: 0n,
  platformShareMinor: 0n,
};

function common(record: PromotionRecord): Common {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    name: record.name,
    funding: record.funding,
    ownerSellerId: record.ownerSellerId,
    combinable: record.combinable,
    code: record.code,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    testMode: record.testMode,
    reward: record.reward,
    currency: record.currency,
    minSpendMinor: record.minSpendMinor,
    maxTotalUses: record.maxTotalUses,
    maxUsesPerCustomer: record.maxUsesPerCustomer,
    productIds: record.productIds,
    sellerIds: record.sellerIds,
    zones: record.zones,
    tiers: record.tiers,
    buyQty: record.buyQty,
    getQty: record.getQty,
    groupQty: record.groupQty,
    bundleItems: record.bundleItems,
    maxRepeatsPerOrder: record.maxRepeatsPerOrder,
    flash:
      record.flashUnitLimit === null || record.flashTimeZone === null
        ? null
        : { unitLimit: record.flashUnitLimit, timeZone: record.flashTimeZone },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export const usageViewOf = (
  record: PromotionRecord,
  usage: UsageRecord | undefined,
): PromotionUsageView => ({ ...common(record), usesCount: (usage ?? ZERO_USAGE).usesCount });

export const promotionViewOf = (
  record: PromotionRecord,
  usage: UsageRecord | undefined,
): PromotionView => ({
  ...common(record),
  platformSplitBps: record.platformSplitBps,
  specialCampaign: record.specialCampaign,
  priorApproved: record.priorApproved,
  pausedBy: record.pausedBy,
  capMinor: record.capMinor,
  maxPerOrderMinor: record.maxPerOrderMinor,
  budgetMinor: record.budgetMinor,
  usage: usage ?? ZERO_USAGE,
});

export const ownViewOf = (
  record: PromotionRecord,
  usage: UsageRecord | undefined,
): OwnPromotionView => ({
  ...common(record),
  pausedBy: record.pausedBy,
  capMinor: record.capMinor,
  maxPerOrderMinor: record.maxPerOrderMinor,
  budgetMinor: record.budgetMinor,
  usesCount: (usage ?? ZERO_USAGE).usesCount,
  // A seller-funded promotion's spend is the seller's own money.
  spentMinor: (usage ?? ZERO_USAGE).spentMinor,
});
