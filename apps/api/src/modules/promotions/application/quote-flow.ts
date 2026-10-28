import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { QuoteRequest, QuoteResult } from '../contracts/promotions.facade';
import { calculateDiscounts } from '../domain/calculation/engine';
import type { CalculationInput, CalculationPromotion } from '../domain/calculation/types';
import { layerOf, platformShareBps, type PromotionRecord } from '../domain/promotion';
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

/** The plain input of a promotion for the pure calculation (a stored promotion with its facts). */
export function calculationPromotionOf(
  record: PromotionRecord,
  usage: UsageRecord | undefined,
  optedInSellers: readonly Id<'Seller'>[],
  settings: PromotionsSettings,
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
    code: record.code,
    specialCampaign: record.specialCampaign,
    reward: record.reward,
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
    const promotion = calculationPromotionOf(
      record,
      usage,
      args.optIns.get(record.id) ?? [],
      settings,
    );
    if (promotion.sellerIds !== null && promotion.sellerIds.length === 0) continue;
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
      return ok({ records, usage, optIns, firstOrder: firstOrder.settings, thresholds });
    },
    { readOnly: true },
  );
  if (!loaded.ok) return err({ code: 'promotions.unavailable' });

  const promotions = promotionsForCart({
    records: loaded.value.records,
    usage: loaded.value.usage,
    optIns: loaded.value.optIns,
    settings,
    firstOrder: loaded.value.firstOrder,
    thresholds: new Map(loaded.value.thresholds.map((row) => [row.zoneCode, row.thresholdMinor])),
    zones,
    testMode: request.testMode,
  });
  const result = calculateDiscounts(
    toInput(request, settings.currency, promotions, settings.lineDiscountCapBps),
  );
  if (!result.ok) {
    return err({ code: 'validation.failed', fields: [{ path: result.error.path, code: 'value' }] });
  }
  return ok({ ...result.value, enabled: true });
}

/** The admin preview takes an admin session (not acting-as); the checkout facade is a system call. */
export const canPreview = (context: CallContext): boolean => adminAccountId(context) !== null;
