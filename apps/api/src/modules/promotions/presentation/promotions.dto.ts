import { ApiProperty } from '@nestjs/swagger';
import type { CalculationOutput } from '../domain/calculation/types';
import { PROMOTIONS_STATUSES } from '../domain/market-status';
import { CREATABLE_TYPES, FUNDINGS, PROMOTION_STATUSES } from '../domain/promotion';
import type { FirstOrderView } from '../application/use-cases/view-first-order-settings.use-case';
import type { ThresholdsView } from '../application/use-cases/list-free-shipping-thresholds.use-case';
import type { ReviewItem } from '../application/use-cases/list-promotion-reviews.use-case';
import type { SettingsView } from '../application/use-cases/view-promotions-settings.use-case';
import type { PromotionUsageView } from '../application/use-cases/list-promotions.use-case';
import type { PromotionView } from '../application/use-cases/list-promotions-full.use-case';
import type { OwnPromotionView } from '../application/use-cases/list-own-promotions.use-case';

// Bodies of the promotions routes. Amounts are digit strings of minor units in the Market's
// currency (ADR-0007); instants are ISO strings; ids are UUIDs. A Viewer's body carries usage
// counts only.

const iso = (instant: { toString(): string }): string => instant.toString();
const isoOrNull = (instant: { toString(): string } | null): string | null =>
  instant === null ? null : instant.toString();
const minor = (value: bigint): string => value.toString();
const minorOrNull = (value: bigint | null): string | null =>
  value === null ? null : value.toString();

export class RewardBody {
  @ApiProperty({ enum: ['PERCENT', 'FIXED'] }) kind!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Basis points (10000 is 100 %) for PERCENT.',
  })
  bps!: number | null;
  @ApiProperty({ nullable: true, type: String, description: 'Minor units for FIXED.' })
  amountMinor!: string | null;
}

export class TierBody {
  @ApiProperty({
    type: String,
    description: 'Goods amount, minor units, from which the tier applies.',
  })
  thresholdMinor!: string;
  @ApiProperty({ type: RewardBody }) reward!: RewardBody;
}

export class BundleItemBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ description: 'Units of the product in one set.' }) quantity!: number;
}

export class FlashBody {
  @ApiProperty({ description: 'The units the sale may sell in all.' }) unitLimit!: number;
  @ApiProperty({
    description: 'The IANA zone of the owning party, in which the window was written.',
  })
  timeZone!: string;
}

class PromotionCommonBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: [...CREATABLE_TYPES] }) type!: string;
  @ApiProperty({ enum: [...PROMOTION_STATUSES] }) status!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: [...FUNDINGS] }) funding!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) ownerSellerId!: string | null;
  @ApiProperty() combinable!: boolean;
  @ApiProperty({ nullable: true, type: String }) code!: string | null;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) endsAt!: string | null;
  @ApiProperty() testMode!: boolean;
  @ApiProperty({ type: RewardBody }) reward!: RewardBody;
  @ApiProperty() currency!: string;
  @ApiProperty({ nullable: true, type: String }) minSpendMinor!: string | null;
  @ApiProperty({ nullable: true, type: Number }) maxTotalUses!: number | null;
  @ApiProperty({ nullable: true, type: Number }) maxUsesPerCustomer!: number | null;
  @ApiProperty({ type: [String], description: 'Empty is any product.' }) productIds!: string[];
  @ApiProperty({ type: [String], description: 'Empty is any seller.' }) sellerIds!: string[];
  @ApiProperty({ type: [String], description: 'Empty is any delivery zone.' }) zones!: string[];
  @ApiProperty({ type: [TierBody], description: 'TIERED_CART only, lowest threshold first.' })
  tiers!: TierBody[];
  @ApiProperty({ nullable: true, type: Number, description: 'BUY_X_GET_Y: units to buy.' })
  buyQty!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'BUY_X_GET_Y: cheapest units rewarded.',
  })
  getQty!: number | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'MULTI_BUY: units in one group; the group price is `reward.amountMinor`.',
  })
  groupQty!: number | null;
  @ApiProperty({
    type: [BundleItemBody],
    description: 'BUNDLE: the items of one set; the amount off a set is `reward.amountMinor`.',
  })
  bundleItems!: BundleItemBody[];
  @ApiProperty({ nullable: true, type: Number }) maxRepeatsPerOrder!: number | null;
  @ApiProperty({ nullable: true, type: FlashBody }) flash!: FlashBody | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** The Viewer's row: usage count, no cost, budget or share. */
export class PromotionUsageBody extends PromotionCommonBody {
  @ApiProperty() usesCount!: number;
}

export class UsageBody {
  @ApiProperty() usesCount!: number;
  @ApiProperty({ type: String }) spentMinor!: string;
  @ApiProperty({ type: String }) sellerShareMinor!: string;
  @ApiProperty({ type: String }) platformShareMinor!: string;
}

export class PromotionBody extends PromotionCommonBody {
  @ApiProperty({ nullable: true, type: Number }) platformSplitBps!: number | null;
  @ApiProperty() specialCampaign!: boolean;
  @ApiProperty() priorApproved!: boolean;
  @ApiProperty({ enum: ['ADMIN', 'SELLER'], nullable: true, type: String }) pausedBy!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) capMinor!: string | null;
  @ApiProperty({ nullable: true, type: String }) maxPerOrderMinor!: string | null;
  @ApiProperty({ nullable: true, type: String }) budgetMinor!: string | null;
  @ApiProperty({ type: UsageBody }) usage!: UsageBody;
}

export class OwnPromotionBody extends PromotionCommonBody {
  @ApiProperty({ enum: ['ADMIN', 'SELLER'], nullable: true, type: String }) pausedBy!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) capMinor!: string | null;
  @ApiProperty({ nullable: true, type: String }) maxPerOrderMinor!: string | null;
  @ApiProperty({ nullable: true, type: String }) budgetMinor!: string | null;
  @ApiProperty() usesCount!: number;
  @ApiProperty({ type: String }) spentMinor!: string;
}

export class PromotionsBody {
  @ApiProperty({ type: [PromotionBody] }) items!: PromotionBody[];
}
export class PromotionUsageListBody {
  @ApiProperty({ type: [PromotionUsageBody] }) items!: PromotionUsageBody[];
}
export class OwnPromotionsBody {
  @ApiProperty({ type: [OwnPromotionBody] }) items!: OwnPromotionBody[];
}

export class SettingsBody {
  @ApiProperty({ enum: [...PROMOTIONS_STATUSES] }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
}

export class SetSettingsRequest {
  @ApiProperty({ enum: [...PROMOTIONS_STATUSES] }) status!: string;
}

/** The request body of a create or an edit (an edit adds nothing: the id is in the path). */
export class PromotionRequest {
  @ApiProperty({ enum: [...CREATABLE_TYPES] }) type!: string;
  @ApiProperty({ maxLength: 120 }) name!: string;
  @ApiProperty({ enum: [...FUNDINGS] }) funding!: string;
  @ApiProperty({
    required: false,
    type: Number,
    description: 'Platform share of a CO_FUNDED campaign, basis points.',
  })
  platformSplitBps?: number;
  @ApiProperty({ required: false }) combinable?: boolean;
  @ApiProperty({ required: false, description: 'The public code of a CART_CODE promotion.' })
  code?: string;
  @ApiProperty({ format: 'date-time', required: false }) startsAt?: string;
  @ApiProperty({ format: 'date-time', required: false }) endsAt?: string;
  @ApiProperty({ required: false }) testMode?: boolean;
  @ApiProperty({ required: false, description: 'Admin only; needs a fresh two-step code.' })
  specialCampaign?: boolean;
  @ApiProperty({
    type: Object,
    required: false,
    description:
      '`{ kind: "PERCENT", bps }` or `{ kind: "FIXED", amountMinor }`. Per unit for BUY_X_GET_Y ' +
      'and FLASH_SALE; FIXED (the amount off one set) for BUNDLE. Not accepted for TIERED_CART ' +
      '(its tiers) and MULTI_BUY (its group price).',
  })
  reward?: object;
  @ApiProperty({
    required: false,
    type: [Object],
    description:
      'TIERED_CART: `{ thresholdMinor, reward }` per tier (all PERCENT or all FIXED; higher ' +
      'tiers give more). The highest tier the goods amount reaches applies.',
  })
  tiers?: object[];
  @ApiProperty({ required: false, description: 'BUY_X_GET_Y: units to buy.' }) buyQty?: number;
  @ApiProperty({
    required: false,
    description: 'BUY_X_GET_Y: the cheapest units that get the reward.',
  })
  getQty?: number;
  @ApiProperty({ required: false, description: 'MULTI_BUY: units in one group (2 or more).' })
  groupQty?: number;
  @ApiProperty({ required: false, description: 'MULTI_BUY: the price of one group, minor units.' })
  groupPriceMinor?: string;
  @ApiProperty({
    required: false,
    type: [Object],
    description: 'BUNDLE: `{ productId, quantity }` per item of one set (2 or more items).',
  })
  bundleItems?: object[];
  @ApiProperty({
    required: false,
    description: 'BUY_X_GET_Y, MULTI_BUY, BUNDLE: the most groups or sets in one order.',
  })
  maxRepeatsPerOrder?: number;
  @ApiProperty({
    required: false,
    type: Object,
    description:
      'FLASH_SALE: `{ unitLimit, timeZone, startsLocal?, endsLocal? }`. `timeZone` is the IANA ' +
      'zone of the owning party; with `startsLocal` and `endsLocal` (wall-clock `YYYY-MM-DDTHH:mm`) ' +
      'the window is written in that zone and stored as UTC instants, and `startsAt` and `endsAt` ' +
      'are not sent. A local time that does not exist or happens twice is refused. A flash sale ' +
      'always has an end.',
  })
  flash?: object;
  @ApiProperty({ required: false, description: 'Minor units, digits only.' }) capMinor?: string;
  @ApiProperty({ required: false }) maxPerOrderMinor?: string;
  @ApiProperty({ required: false }) maxTotalUses?: number;
  @ApiProperty({ required: false }) maxUsesPerCustomer?: number;
  @ApiProperty({ required: false, description: 'Required for a platform promotion.' })
  budgetMinor?: string;
  @ApiProperty({ required: false }) minSpendMinor?: string;
  @ApiProperty({ required: false, type: [String] }) productIds?: string[];
  @ApiProperty({ required: false, type: [String] }) sellerIds?: string[];
  @ApiProperty({ required: false, type: [String] }) zones?: string[];
}

export class GenerateBatchCodesRequest {
  @ApiProperty({ description: "How many codes to make; at most the Market's `maxPerBatch`." })
  count!: number;
}

export class BatchCodeSummaryBody {
  @ApiProperty({ format: 'uuid' }) promotionId!: string;
  @ApiProperty() total!: number;
  @ApiProperty() used!: number;
  @ApiProperty({ description: 'The most codes the Market lets one promotion hold.' })
  maxPerPromotion!: number;
}

export class BudgetRequest {
  @ApiProperty({ description: 'Minor units, digits only.', example: '150000' })
  budgetMinor!: string;
}

export class OptInRequest {
  @ApiProperty() optIn!: boolean;
}

export class OptInBody {
  @ApiProperty({ format: 'uuid' }) promotionId!: string;
  @ApiProperty() optedIn!: boolean;
}

export class ReviewDecisionRequest {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) decision!: string;
  @ApiProperty({
    format: 'date-time',
    description:
      'The `updatedAt` of the promotion in the queue item the admin looked at. A promotion changed since answers promotions.invalid-state (409).',
  })
  promotionVersion!: string;
}

export class ReviewEntryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) promotionId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ enum: ['NEW_SELLER', 'HIGH_DISCOUNT', 'POST_REVIEW'] }) reason!: string;
  @ApiProperty({ enum: ['OPEN', 'APPROVED', 'REJECTED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) openedAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) decidedAt!: string | null;
}

export class ReviewItemBody {
  @ApiProperty({ type: ReviewEntryBody }) review!: ReviewEntryBody;
  @ApiProperty({ type: PromotionBody }) promotion!: PromotionBody;
}

export class ReviewQueueBody {
  @ApiProperty({ type: [ReviewItemBody] }) items!: ReviewItemBody[];
}

export class FirstOrderSettingsBody {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['PERCENT', 'FIXED'] }) kind!: string;
  @ApiProperty({ nullable: true, type: Number }) percentBps!: number | null;
  @ApiProperty({ nullable: true, type: String }) amountMinor!: string | null;
  @ApiProperty({ nullable: true, type: String }) capMinor!: string | null;
  @ApiProperty({ type: String }) minSpendMinor!: string;
  @ApiProperty({ type: String }) monthlyBudgetMinor!: string;
}

export class FirstOrderBody {
  @ApiProperty({ type: FirstOrderSettingsBody, nullable: true })
  settings!: FirstOrderSettingsBody | null;
  @ApiProperty({ enum: ['stored', 'config', 'none'] }) source!: string;
  @ApiProperty() currency!: string;
}

export class FirstOrderRequest {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['PERCENT', 'FIXED'] }) kind!: string;
  @ApiProperty({ required: false, type: Number }) percentBps?: number;
  @ApiProperty({ required: false, description: 'Minor units, digits only.' }) amountMinor?: string;
  @ApiProperty({ required: false }) capMinor?: string;
  @ApiProperty() minSpendMinor!: string;
  @ApiProperty() monthlyBudgetMinor!: string;
}

export class ThresholdBody {
  @ApiProperty() zoneCode!: string;
  @ApiProperty({ type: String }) thresholdMinor!: string;
}

export class ThresholdsBody {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: String, description: 'Used by a zone with no threshold of its own.' })
  defaultThresholdMinor!: string;
  @ApiProperty({ type: [ThresholdBody] }) zones!: ThresholdBody[];
}

export class ThresholdRequest {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null returns the zone to the Market default.',
  })
  thresholdMinor!: string | null;
}

export class ThresholdResultBody {
  @ApiProperty() zoneCode!: string;
  @ApiProperty({ type: String, nullable: true }) thresholdMinor!: string | null;
}

export class QuoteRequestBody {
  @ApiProperty({
    type: [Object],
    description: '`{ id, sellerId, productId, unitPriceMinor, quantity }`.',
  })
  lines!: object[];
  @ApiProperty({
    type: [Object],
    required: false,
    description: '`{ id, sellerId?, zoneCode, amountMinor }`.',
  })
  shipping?: object[];
  @ApiProperty({ required: false }) code?: string;
  @ApiProperty({ required: false }) isFirstOrder?: boolean;
  @ApiProperty({ required: false, description: 'Defaults to true for the preview.' })
  testMode?: boolean;
  @ApiProperty({ required: false }) orderCommissionMinor?: string;
}

export class QuoteBody {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ['NONE', 'APPLIED', 'NOT_APPLIED', 'UNKNOWN'] }) code!: string;
  @ApiProperty({ type: [Object] }) lines!: object[];
  @ApiProperty({ type: [Object] }) shipping!: object[];
  @ApiProperty({ type: [Object] }) applied!: object[];
  @ApiProperty({ type: Object }) totals!: object;
}

const rewardBody = (reward: PromotionUsageView['reward']): RewardBody =>
  reward.kind === 'PERCENT'
    ? { kind: 'PERCENT', bps: reward.bps, amountMinor: null }
    : { kind: 'FIXED', bps: null, amountMinor: minor(reward.amount) };

type Common = PromotionUsageView | PromotionView | OwnPromotionView;
function common(view: Common) {
  return {
    id: view.id,
    type: view.type,
    status: view.status,
    name: view.name,
    funding: view.funding,
    ownerSellerId: view.ownerSellerId,
    combinable: view.combinable,
    code: view.code,
    startsAt: iso(view.startsAt),
    endsAt: isoOrNull(view.endsAt),
    testMode: view.testMode,
    reward: rewardBody(view.reward),
    currency: view.currency,
    minSpendMinor: minorOrNull(view.minSpendMinor),
    maxTotalUses: view.maxTotalUses,
    maxUsesPerCustomer: view.maxUsesPerCustomer,
    productIds: [...view.productIds],
    sellerIds: [...view.sellerIds],
    zones: [...view.zones],
    tiers: view.tiers.map((tier) => ({
      thresholdMinor: minor(tier.thresholdMinor),
      reward: rewardBody(tier.reward),
    })),
    buyQty: view.buyQty,
    getQty: view.getQty,
    groupQty: view.groupQty,
    bundleItems: view.bundleItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    maxRepeatsPerOrder: view.maxRepeatsPerOrder,
    flash:
      view.flash === null
        ? null
        : { unitLimit: view.flash.unitLimit, timeZone: view.flash.timeZone },
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
  };
}

export const usageBody = (view: PromotionUsageView): PromotionUsageBody => ({
  ...common(view),
  usesCount: view.usesCount,
});

export const promotionBody = (view: PromotionView): PromotionBody => ({
  ...common(view),
  platformSplitBps: view.platformSplitBps,
  specialCampaign: view.specialCampaign,
  priorApproved: view.priorApproved,
  pausedBy: view.pausedBy,
  capMinor: minorOrNull(view.capMinor),
  maxPerOrderMinor: minorOrNull(view.maxPerOrderMinor),
  budgetMinor: minorOrNull(view.budgetMinor),
  usage: {
    usesCount: view.usage.usesCount,
    spentMinor: minor(view.usage.spentMinor),
    sellerShareMinor: minor(view.usage.sellerShareMinor),
    platformShareMinor: minor(view.usage.platformShareMinor),
  },
});

export const ownBody = (view: OwnPromotionView): OwnPromotionBody => ({
  ...common(view),
  pausedBy: view.pausedBy,
  capMinor: minorOrNull(view.capMinor),
  maxPerOrderMinor: minorOrNull(view.maxPerOrderMinor),
  budgetMinor: minorOrNull(view.budgetMinor),
  usesCount: view.usesCount,
  spentMinor: minor(view.spentMinor),
});

export const settingsBody = (view: SettingsView): SettingsBody => ({
  status: view.status,
  updatedAt: isoOrNull(view.updatedAt),
});

export const reviewItemBody = (item: ReviewItem): ReviewItemBody => ({
  review: {
    id: item.review.id,
    promotionId: item.review.promotionId,
    sellerId: item.review.sellerId,
    reason: item.review.reason,
    status: item.review.status,
    openedAt: iso(item.review.openedAt),
    decidedAt: isoOrNull(item.review.decidedAt),
  },
  promotion: promotionBody(item.promotion),
});

export const firstOrderBody = (view: FirstOrderView): FirstOrderBody => ({
  settings:
    view.settings === null
      ? null
      : {
          enabled: view.settings.enabled,
          kind: view.settings.kind,
          percentBps: view.settings.percentBps,
          amountMinor: minorOrNull(view.settings.amountMinor),
          capMinor: minorOrNull(view.settings.capMinor),
          minSpendMinor: minor(view.settings.minSpendMinor),
          monthlyBudgetMinor: minor(view.settings.monthlyBudgetMinor),
        },
  source: view.source,
  currency: view.currency,
});

export const thresholdsBody = (view: ThresholdsView): ThresholdsBody => ({
  currency: view.currency,
  defaultThresholdMinor: minor(view.defaultThresholdMinor),
  zones: view.zones.map((zone) => ({
    zoneCode: zone.zoneCode,
    thresholdMinor: minor(zone.thresholdMinor),
  })),
});

const allocationBody = (a: CalculationOutput['lines'][number]['allocations'][number]) => ({
  promotionId: a.promotionId,
  layer: a.layer,
  amountMinor: minor(a.amount),
  sellerShareMinor: minor(a.sellerShare),
  platformShareMinor: minor(a.platformShare),
});

export const quoteBody = (result: CalculationOutput & { enabled: boolean }): QuoteBody => ({
  enabled: result.enabled,
  currency: result.currency,
  code: result.code,
  lines: result.lines.map((line) => ({
    lineId: line.lineId,
    grossMinor: minor(line.gross),
    discountMinor: minor(line.discount),
    netMinor: minor(line.net),
    allocations: line.allocations.map(allocationBody),
  })),
  shipping: result.shipping.map((charge) => ({
    shippingId: charge.shippingId,
    grossMinor: minor(charge.gross),
    discountMinor: minor(charge.discount),
    netMinor: minor(charge.net),
    allocations: charge.allocations.map(allocationBody),
  })),
  applied: result.applied.map((a) => ({
    promotionId: a.promotionId,
    layer: a.layer,
    amountMinor: minor(a.amount),
    sellerShareMinor: minor(a.sellerShare),
    platformShareMinor: minor(a.platformShare),
  })),
  totals: {
    goodsGrossMinor: minor(result.totals.goodsGross),
    goodsDiscountMinor: minor(result.totals.goodsDiscount),
    goodsNetMinor: minor(result.totals.goodsNet),
    sellerShareMinor: minor(result.totals.sellerShare),
    platformShareMinor: minor(result.totals.platformShare),
    shippingGrossMinor: minor(result.totals.shippingGross),
    shippingDiscountMinor: minor(result.totals.shippingDiscount),
    shippingNetMinor: minor(result.totals.shippingNet),
    payableMinor: minor(result.totals.payable),
  },
});
