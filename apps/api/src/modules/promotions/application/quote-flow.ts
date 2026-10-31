import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { QuoteRequest, QuoteResult } from '../contracts/promotions.facade';
import { calculateDiscounts, validatePhase2 } from '../domain/calculation/engine';
import type { CalculationInput, CalculationPromotion } from '../domain/calculation/types';
import {
  layerOf,
  normaliseCode,
  platformShareBps,
  type PromotionRecord,
} from '../domain/promotion';
import type { PromotionsFailure } from './failures';
import { adminAccountId } from './caller';
import { activeSettings } from './market-switch';
import type { UsageRecord } from './ports/promotion.repository';
import type { FirstOrderSettings, PromotionsSettings } from './ports/promotions-policy';
import type { PromotionsDependencies } from './promotions-dependencies';
import { effectiveFirstOrder } from './admin-settings-flow';

// The quote: the server-side calculation of the discounts of one cart (promotions package T1).
// The caller supplies the cart as the platform knows it (prices from pricing, never from the
// browser); this reads the live promotions of the Market and runs the pure calculation. With the
// Market switch off, or no promotions settings, it returns the cart with no discount.

const MAX_LINES = 100;
const MAX_SHIPPING = 50;

/** What a quote knows about a promotion beyond its stored terms. */
export interface PromotionExtras {
  /** The units a limited promotion (flash sale) may still discount; absent for no limit. */
  readonly unitLimit?: number;
  /** The entered single-use code this promotion answers to, and whether it was redeemed already. */
  readonly code?: string;
  readonly codeUsed?: boolean;
}

/** The plain input of a promotion for the pure calculation (a stored promotion with its facts). */
export function calculationPromotionOf(
  record: PromotionRecord,
  usage: UsageRecord | undefined,
  optedInSellers: readonly Id<'Seller'>[],
  settings: PromotionsSettings,
  extra: PromotionExtras = {},
): CalculationPromotion {
  const spent = usage?.spentMinor ?? 0n;
  const remaining =
    record.budgetMinor === null
      ? null
      : record.budgetMinor > spent
        ? record.budgetMinor - spent
        : 0n;
  const sellerFunded = record.funding === 'SELLER';
  let sellerIds: readonly string[] | null = record.sellerIds.length > 0 ? record.sellerIds : null;
  if (record.type === 'CO_FUNDED_CAMPAIGN') {
    // Only sellers that opted in (and that the campaign is aimed at) are in it.
    sellerIds = optedInSellers.filter((id) => sellerIds === null || sellerIds.includes(id));
  }
  return {
    id: record.id,
    type: record.type,
    layer: layerOf(record.type, record.ownerSellerId === null ? 'platform' : 'seller'),
    platformShareBps: platformShareBps(record.funding, record.platformSplitBps),
    sellerId: record.ownerSellerId,
    combinable: record.combinable,
    // A single-use code is the one the customer entered, found among the generated codes.
    code: extra.code ?? record.code,
    codeUsed: extra.codeUsed ?? false,
    specialCampaign: record.specialCampaign,
    reward: record.reward,
    tiers:
      record.type === 'TIERED_CART'
        ? record.tiers.map((tier) => ({ threshold: tier.thresholdMinor, reward: tier.reward }))
        : null,
    buyXGetY:
      record.type === 'BUY_X_GET_Y' && record.buyQty !== null && record.getQty !== null
        ? { buyQty: record.buyQty, getQty: record.getQty, maxRepeats: record.maxRepeatsPerOrder }
        : null,
    // The reward of a multi-buy is FIXED: the price of one group; of a bundle, the amount off a set.
    multiBuy:
      record.type === 'MULTI_BUY' && record.groupQty !== null && record.reward.kind === 'FIXED'
        ? {
            groupQty: record.groupQty,
            groupPrice: record.reward.amount,
            maxRepeats: record.maxRepeatsPerOrder,
          }
        : null,
    bundle:
      record.type === 'BUNDLE' && record.reward.kind === 'FIXED'
        ? {
            items: record.bundleItems,
            amountOff: record.reward.amount,
            maxRepeats: record.maxRepeatsPerOrder,
          }
        : null,
    unitLimit: extra.unitLimit ?? null,
    // A seller's promotion is held to the Market's seller maximum, and, until an admin has
    // approved or reviewed it, to the approval threshold too (a fixed amount cannot be compared
    // with a price when it is written).
    maxShareBps: sellerFunded
      ? record.priorApproved
        ? settings.rules.sellerMaxDiscountBps
        : Math.min(settings.rules.sellerMaxDiscountBps, settings.rules.priorApprovalDiscountBps)
      : null,
    // A co-funded campaign is held to the seller maximum on the seller's own share of every line:
    // the seller pays what the platform does not, whatever the reward and the split.
    sellerMaxShareBps: record.funding === 'CO_FUNDED' ? settings.rules.sellerMaxDiscountBps : null,
    capAmount: record.capMinor,
    maxPerOrder: record.maxPerOrderMinor,
    budgetRemaining: remaining,
    minSpend: record.minSpendMinor,
    productIds: record.productIds.length > 0 ? record.productIds : null,
    sellerIds,
    zones: record.zones.length > 0 ? record.zones : null,
    firstOrderOnly: false,
  };
}

const logger = new Logger('PromotionsQuote');

/** The promotions the calculation sees: live ones that may apply to this cart, plus the settings-based ones. */
export function promotionsForCart(args: {
  readonly records: readonly PromotionRecord[];
  readonly usage: ReadonlyMap<Id<'Promotion'>, UsageRecord>;
  readonly optIns: ReadonlyMap<Id<'Promotion'>, readonly Id<'Seller'>[]>;
  readonly settings: PromotionsSettings;
  readonly firstOrder: FirstOrderSettings | null;
  readonly thresholds: ReadonlyMap<string, bigint>;
  readonly zones: readonly string[];
  readonly testMode: boolean;
  /** Units a flash sale may still sell, per promotion; a flash sale not in the map is left out. */
  readonly flashRemaining?: ReadonlyMap<Id<'Promotion'>, number>;
  /** The generated single-use code the customer entered, if it exists. */
  readonly batch?: {
    readonly promotionId: Id<'Promotion'>;
    readonly code: string;
    readonly used: boolean;
  } | null;
}): CalculationPromotion[] {
  const { settings, testMode } = args;
  // Platform money is test-mode only until the Market confirms the tax ruling; checked again here
  // so that a promotion stored before the flag changed back cannot slip into a real order.
  const platformMoneyAllowed = settings.rules.gstRulingConfirmed || testMode;
  const out: CalculationPromotion[] = [];
  for (const record of args.records) {
    if (record.currency !== settings.currency) continue;
    if (record.testMode && !testMode) continue;
    if (record.funding !== 'SELLER' && !platformMoneyAllowed) continue;
    const usage = args.usage.get(record.id);
    if (record.maxTotalUses !== null && (usage?.usesCount ?? 0) >= record.maxTotalUses) continue;
    // A row without the terms its type needs cannot come from a use case; it is left out so that
    // one bad row never fails the quote of every cart.
    if (record.type === 'TIERED_CART' && record.tiers.length === 0) continue;
    if (record.type === 'BUNDLE' && record.bundleItems.length < 2) continue;
    if (record.type === 'BUY_X_GET_Y' && (record.buyQty === null || record.getQty === null))
      continue;
    if (record.type === 'MULTI_BUY' && record.groupQty === null) continue;
    // One code per order: when the entered text is a generated single-use code, a public code
    // with the same text is not a candidate, so the single-use code is the one that counts.
    if (
      record.type !== 'BATCH_CODE' &&
      record.code !== null &&
      args.batch != null &&
      record.code === args.batch.code
    ) {
      continue;
    }
    const extra: { unitLimit?: number; code?: string; codeUsed?: boolean } = {};
    if (record.type === 'BATCH_CODE') {
      // Only the entered code's promotion is a candidate; the others are not looked at.
      if (args.batch == null || args.batch.promotionId !== record.id) continue;
      extra.code = args.batch.code;
      extra.codeUsed = args.batch.used;
    }
    if (record.type === 'FLASH_SALE') {
      const left = args.flashRemaining?.get(record.id);
      if (left === undefined || left < 1) continue;
      extra.unitLimit = left;
    }
    const promotion = calculationPromotionOf(
      record,
      usage,
      args.optIns.get(record.id) ?? [],
      settings,
      extra,
    );
    if (promotion.sellerIds !== null && promotion.sellerIds.length === 0) continue;
    // The engine refuses a malformed promotion for the whole cart; one bad row must not fail the
    // quote of every cart in the Market, so it is checked here and left out (the id is logged).
    const malformed = validatePhase2(promotion);
    if (malformed !== null) {
      logger.warn({
        msg: 'promotions.quote.skipped-malformed',
        promotionId: record.id,
        rule: malformed,
      });
      continue;
    }
    out.push(promotion);
  }
  const firstOrder = args.firstOrder;
  if (firstOrder !== null && firstOrder.enabled && platformMoneyAllowed) {
    out.push({
      id: 'first-order',
      type: 'FIRST_ORDER',
      layer: 'PLATFORM_CART',
      platformShareBps: 10000,
      sellerId: null,
      combinable: true,
      code: null,
      specialCampaign: false,
      reward:
        firstOrder.kind === 'PERCENT'
          ? { kind: 'PERCENT', bps: firstOrder.percentBps ?? 0 }
          : { kind: 'FIXED', amount: firstOrder.amountMinor ?? 0n },
      maxShareBps: null,
      capAmount: firstOrder.capMinor,
      maxPerOrder: null,
      // The month's spend is reserved by package T2; here the whole monthly budget is the ceiling.
      budgetRemaining: firstOrder.monthlyBudgetMinor,
      minSpend: firstOrder.minSpendMinor,
      productIds: null,
      sellerIds: null,
      zones: null,
      firstOrderOnly: true,
    });
  }
  if (platformMoneyAllowed) {
    for (const zone of args.zones) {
      out.push({
        id: `free-shipping:${zone}`,
        type: 'FREE_SHIPPING',
        layer: 'SHIPPING',
        platformShareBps: 10000,
        sellerId: null,
        combinable: true,
        code: null,
        specialCampaign: false,
        reward: { kind: 'PERCENT', bps: 10000 },
        maxShareBps: null,
        capAmount: null,
        maxPerOrder: null,
        budgetRemaining: null,
        minSpend: args.thresholds.get(zone) ?? settings.freeShippingThresholdMinor,
        productIds: null,
        sellerIds: null,
        zones: [zone],
        firstOrderOnly: false,
      });
    }
  }
  return out;
}

const NO_DISCOUNT_RULES = { lineDiscountCapBps: 10000 };

function toInput(
  request: QuoteRequest,
  currency: string,
  promotions: CalculationPromotion[],
  lineDiscountCapBps: number,
): CalculationInput {
  return {
    currency,
    lines: request.lines.map((line) => ({
      id: line.id,
      sellerId: line.sellerId,
      productId: line.productId,
      unitPrice: line.unitPrice.amount,
      quantity: line.quantity,
    })),
    shipping: request.shipping.map((charge) => ({
      id: charge.id,
      sellerId: charge.sellerId,
      zoneCode: charge.zoneCode,
      amount: charge.amount.amount,
    })),
    promotions,
    code: request.code,
    isFirstOrder: request.isFirstOrder,
    orderCommission: request.orderCommission.amount,
    rules: { lineDiscountCapBps },
  };
}

function checkShape(
  request: QuoteRequest,
  currency: string,
): readonly { path: string; code: string }[] {
  const issues: { path: string; code: string }[] = [];
  if (request.lines.length === 0 || request.lines.length > MAX_LINES) {
    issues.push({ path: 'lines', code: 'size' });
  }
  if (request.shipping.length > MAX_SHIPPING) issues.push({ path: 'shipping', code: 'size' });
  const wrong =
    request.lines.some((line) => line.unitPrice.currency !== currency) ||
    request.shipping.some((charge) => charge.amount.currency !== currency) ||
    request.orderCommission.currency !== currency;
  if (wrong) issues.push({ path: 'currency', code: 'mismatch' });
  return issues;
}

/**
 * Quotes a cart. `strict`: a switch that is off or unavailable is a refusal (the admin preview);
 * otherwise it is a cart with no discount and `enabled: false` (the facade the checkout calls,
 * which must never fail a cart because promotions are off).
 */
export async function quote(
  deps: PromotionsDependencies,
  context: CallContext,
  request: QuoteRequest,
  strict: boolean,
): Promise<Result<QuoteResult, PromotionsFailure>> {
  // The shape of the cart comes first, with the switch on or off: every amount in the Market's
  // currency (when the Market has no settings, in one currency), and the sizes in bounds.
  const currency =
    deps.policy.settings(context.market)?.currency ?? request.orderCommission.currency;
  const shape = checkShape(request, currency);
  if (shape.length > 0) return err({ code: 'validation.failed', fields: shape });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) {
    if (strict) return switched;
    const bare = calculateDiscounts(
      toInput(request, currency, [], NO_DISCOUNT_RULES.lineDiscountCapBps),
    );
    return bare.ok
      ? ok({ ...bare.value, enabled: false })
      : err({ code: 'validation.failed', fields: [{ path: bare.error.path, code: 'value' }] });
  }
  const settings = switched.value;
  const now = deps.clock.now();
  const zones = [...new Set(request.shipping.map((charge) => charge.zoneCode))].sort();
  const code = request.code === null ? null : normaliseCode(request.code);

  const loaded = await deps.unitOfWork.run(
    context.market,
    async () => {
      const records = await deps.promotions.listLive(context.market, now, {
        sellerIds: [...new Set(request.lines.map((line) => line.sellerId))].sort(),
        productIds: [...new Set(request.lines.map((line) => line.productId))].sort(),
      });
      const ids = records.map((record) => record.id);
      const usage = await deps.promotions.usageOf(context.market, ids);
      const optIns = await deps.optIns.liveSellers(
        context.market,
        records.filter((record) => record.type === 'CO_FUNDED_CAMPAIGN').map((record) => record.id),
      );
      const firstOrder = await effectiveFirstOrder(deps, context, settings);
      const thresholds = await deps.thresholds.list(context.market);
      // The entered code may be a generated single-use code: found by its hash, never by the text.
      const found =
        code === null || !deps.codeCrypto.available
          ? null
          : await deps.batchCodes.find(context.market, deps.codeCrypto.hash(code));
      return ok({
        records,
        usage,
        optIns,
        firstOrder: firstOrder.settings,
        thresholds,
        found,
      });
    },
    { readOnly: true },
  );
  if (!loaded.ok) return err({ code: 'promotions.unavailable' });

  // Units left of each flash sale: its limit less the units sold, from the counter port. A count
  // that cannot be read is unknown: the sale is left out of a real order (fail closed) and counts
  // as sold 0 in a test order only.
  const flash = loaded.value.records.filter((record) => record.type === 'FLASH_SALE');
  const sold =
    flash.length === 0
      ? null
      : await deps.flashSales.soldUnits(
          context,
          flash.map((record) => record.id),
        );
  const flashRemaining = new Map<Id<'Promotion'>, number>();
  for (const record of flash) {
    const count = sold?.get(record.id) ?? (request.testMode ? 0 : null);
    if (count === null || record.flashUnitLimit === null) continue;
    flashRemaining.set(record.id, Math.max(0, record.flashUnitLimit - count));
  }

  const promotions = promotionsForCart({
    records: loaded.value.records,
    usage: loaded.value.usage,
    optIns: loaded.value.optIns,
    settings,
    firstOrder: loaded.value.firstOrder,
    thresholds: new Map(loaded.value.thresholds.map((row) => [row.zoneCode, row.thresholdMinor])),
    zones,
    testMode: request.testMode,
    flashRemaining,
    batch:
      code === null || loaded.value.found === null
        ? null
        : {
            promotionId: loaded.value.found.promotionId,
            code,
            used: loaded.value.found.usedAt !== null,
          },
  });
  const result = calculateDiscounts(
    toInput({ ...request, code }, settings.currency, promotions, settings.lineDiscountCapBps),
  );
  if (!result.ok) {
    return err({ code: 'validation.failed', fields: [{ path: result.error.path, code: 'value' }] });
  }
  return ok({ ...result.value, enabled: true });
}

/** The admin preview takes an admin session (not acting-as); the checkout facade is a system call. */
export const canPreview = (context: CallContext): boolean => adminAccountId(context) !== null;
