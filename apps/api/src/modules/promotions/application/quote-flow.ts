import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { QuoteRequest, QuoteResult } from '../contracts/promotions.facade';
import { calculateDiscounts, validatePhase2 } from '../domain/calculation/engine';
import { wholeDaysBetween } from '../domain/credit';
import type {
  Audience,
  CalculationInput,
  CalculationPromotion,
  CustomerFacts,
} from '../domain/calculation/types';
import {
  isCreditType,
  layerOf,
  normaliseCode,
  platformShareBps,
  type DiscountType,
  type PromotionRecord,
} from '../domain/promotion';
import type { PromotionsFailure } from './failures';
import { adminAccountId } from './caller';
import { activeSettings } from './market-switch';
import { budgetMonthOf } from '../domain/redemption';
import type { BatchCodeRecord } from './ports/batch-code.repository';
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

/** A stored promotion that is a discount (the credit types never reach the calculation). */
export type DiscountRecord = PromotionRecord & { readonly type: DiscountType };
export const isDiscount = (record: PromotionRecord): record is DiscountRecord =>
  !isCreditType(record.type);

/**
 * Who a customer-group or store-follower promotion is for. A row without the terms its type needs
 * has no audience here and is left out of the quote by the caller.
 */
export function audienceOf(record: PromotionRecord): Audience | null {
  if (record.type === 'STORE_FOLLOWER') return { kind: 'STORE_FOLLOWER' };
  if (record.type !== 'CUSTOMER_GROUP') return null;
  if (record.segmentKind === 'RETURNING_CUSTOMER' && record.segmentMinDays !== null) {
    return { kind: 'RETURNING_CUSTOMER', minDaysSinceLastOrder: record.segmentMinDays };
  }
  if (record.segmentKind === 'DELIVERY_ZONE' && record.zones.length > 0) {
    return { kind: 'DELIVERY_ZONE', zones: record.zones };
  }
  if (record.segmentKind === 'MANUAL_GROUP' && record.segmentGroupId !== null) {
    return { kind: 'MANUAL_GROUP', groupId: record.segmentGroupId };
  }
  // A seller's own discount for its exclusive customers; a platform row could not mean anything.
  if (record.segmentKind === 'SELLER_EXCLUSIVE' && record.ownerSellerId !== null) {
    return { kind: 'SELLER_EXCLUSIVE' };
  }
  return null;
}

/** The plain input of a promotion for the pure calculation (a stored promotion with its facts). */
export function calculationPromotionOf(
  record: DiscountRecord,
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
    // The zones of a customer-group promotion are its audience, not a shipping target.
    zones: record.type !== 'CUSTOMER_GROUP' && record.zones.length > 0 ? record.zones : null,
    firstOrderOnly: false,
    audience: audienceOf(record),
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
  /** First-order money already held in this month (package T2); absent is none. */
  readonly firstOrderSpent?: bigint;
  /**
   * Live uses of each promotion by this customer (package T2). Undefined ignores per-customer limits
   * (the admin preview); null is a cart without a customer, which gets no promotion that has one.
   */
  readonly customerUses?: ReadonlyMap<Id<'Promotion'>, number> | null;
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
    // Wallet credit is a payment instrument, not a discount: never in a quote.
    if (!isDiscount(record)) continue;
    if (record.currency !== settings.currency) continue;
    if (record.testMode && !testMode) continue;
    if (record.funding !== 'SELLER' && !platformMoneyAllowed) continue;
    const usage = args.usage.get(record.id);
    if (record.maxTotalUses !== null && (usage?.usesCount ?? 0) >= record.maxTotalUses) continue;
    if (record.maxUsesPerCustomer !== null && args.customerUses !== undefined) {
      if (args.customerUses === null) continue;
      if ((args.customerUses.get(record.id) ?? 0) >= record.maxUsesPerCustomer) continue;
    }
    // A row without the terms its type needs cannot come from a use case; it is left out so that
    // one bad row never fails the quote of every cart.
    if (record.type === 'TIERED_CART' && record.tiers.length === 0) continue;
    if (record.type === 'BUNDLE' && record.bundleItems.length < 2) continue;
    if (record.type === 'BUY_X_GET_Y' && (record.buyQty === null || record.getQty === null))
      continue;
    if (record.type === 'MULTI_BUY' && record.groupQty === null) continue;
    if (
      (record.type === 'CUSTOMER_GROUP' || record.type === 'STORE_FOLLOWER') &&
      audienceOf(record) === null
    ) {
      continue;
    }
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
      // What is left of this month's budget once the money other orders hold is taken off.
      budgetRemaining:
        firstOrder.monthlyBudgetMinor > (args.firstOrderSpent ?? 0n)
          ? firstOrder.monthlyBudgetMinor - (args.firstOrderSpent ?? 0n)
          : 0n,
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
  customer: CustomerFacts | null = null,
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
    customer,
    orderCommission: request.orderCommission.amount,
    rules: { lineDiscountCapBps },
  };
}

/**
 * What is known about the customer, for the promotions aimed at a segment or at the followers of a
 * store: read only when a live promotion needs it, from the modules that own the facts (outside
 * any unit). A fact that cannot be read, or a quote without a customer, is unknown, and the
 * promotions that need it do not apply (fail closed).
 */
async function customerFactsOf(
  deps: PromotionsDependencies,
  context: CallContext,
  request: QuoteRequest,
  records: readonly PromotionRecord[],
  now: Temporal.Instant,
): Promise<CustomerFacts | null> {
  const accountId = request.customerAccountId ?? null;
  if (accountId === null) return null;
  const needsHistory = records.some(
    (record) => record.type === 'CUSTOMER_GROUP' && record.segmentKind === 'RETURNING_CUSTOMER',
  );
  const needsFollows = records.some((record) => record.type === 'STORE_FOLLOWER');
  const needsExclusive = records.some(
    (record) => record.type === 'CUSTOMER_GROUP' && record.segmentKind === 'SELLER_EXCLUSIVE',
  );
  const groupIds = [
    ...new Set(
      records.flatMap((record) =>
        record.type === 'CUSTOMER_GROUP' &&
        record.segmentKind === 'MANUAL_GROUP' &&
        record.segmentGroupId !== null
          ? [record.segmentGroupId]
          : [],
      ),
    ),
  ].sort();
  if (!needsHistory && !needsFollows && !needsExclusive && groupIds.length === 0) return null;
  let daysSinceLastOrder: number | null = null;
  if (needsHistory) {
    try {
      const last = await deps.orderHistory.lastOrderAt(context, accountId);
      if (last.known && last.value !== null) {
        daysSinceLastOrder = wholeDaysBetween(last.value, now);
      }
    } catch {
      daysSinceLastOrder = null;
    }
  }
  let followedSellerIds: readonly string[] | null = null;
  if (needsFollows) {
    try {
      const sellers = [...new Set(request.lines.map((line) => line.sellerId))].sort();
      const followed = await deps.storeFollows.followedAmong(context, accountId, sellers);
      followedSellerIds = followed.known ? followed.value : null;
    } catch {
      followedSellerIds = null;
    }
  }
  // One read per group; an unknown answer (a refusal, an error, an unknown group) is "not in it".
  const memberOfGroupIds: string[] = [];
  for (const groupId of groupIds) {
    try {
      const member = await deps.groupMembership.isMember(context, groupId, accountId);
      if (member.known && member.value) memberOfGroupIds.push(groupId);
    } catch {
      // Fail closed: the group's promotion does not apply.
    }
  }
  let exclusiveSellerId: string | null = null;
  if (needsExclusive) {
    try {
      const exclusive = await deps.exclusiveCustomers.exclusiveSellerOf(context, accountId, now);
      exclusiveSellerId = exclusive.known ? exclusive.value : null;
    } catch {
      // Fail closed: no exclusive-customer discount.
      exclusiveSellerId = null;
    }
  }
  return { daysSinceLastOrder, followedSellerIds, memberOfGroupIds, exclusiveSellerId };
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

/** What a quote reads from promotions' own tables, in one unit (read-only, or the redemption's). */
export interface LoadedCart {
  readonly records: readonly PromotionRecord[];
  readonly usage: ReadonlyMap<Id<'Promotion'>, UsageRecord>;
  readonly optIns: ReadonlyMap<Id<'Promotion'>, readonly Id<'Seller'>[]>;
  readonly firstOrder: FirstOrderSettings | null;
  readonly thresholds: readonly { readonly zoneCode: string; readonly thresholdMinor: bigint }[];
  readonly found: BatchCodeRecord | null;
  /** See {@link promotionsForCart}: undefined ignores per-customer limits, null is no customer. */
  readonly customerUses: ReadonlyMap<Id<'Promotion'>, number> | null | undefined;
  readonly firstOrderSpent: bigint;
}

/**
 * Reads, inside the caller's unit, what the quote of this cart needs: the live promotions that may
 * apply, their usage, the opt-ins, the settings-based offers, the entered single-use code, the
 * customer's own uses (package T2) and the first-order money held this month.
 */
export async function loadCart(
  deps: PromotionsDependencies,
  context: CallContext,
  request: QuoteRequest,
  settings: PromotionsSettings,
  now: Temporal.Instant,
  code: string | null,
  /** False for the admin preview: a "try a cart" has no customer and ignores per-customer limits. */
  perCustomer: boolean,
): Promise<LoadedCart> {
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
  const accountId = request.customerAccountId ?? null;
  const limited = records
    .filter((record) => record.maxUsesPerCustomer !== null)
    .map((record) => record.id);
  const customerUses = !perCustomer
    ? undefined
    : accountId === null
      ? null
      : await deps.redemptions.customerUses(context.market, accountId, limited);
  const firstOrderSpent =
    firstOrder.settings !== null && firstOrder.settings.enabled
      ? await deps.redemptions.firstOrderSpent(
          context.market,
          budgetMonthOf(now, settings.timeZone),
        )
      : 0n;
  return {
    records,
    usage,
    optIns,
    firstOrder: firstOrder.settings,
    thresholds,
    found,
    customerUses,
    firstOrderSpent,
  };
}

/**
 * The calculation of a loaded cart: the quote and the redemption run this same function, so what
 * checkout shows and what the redemption writes cannot differ for the same facts.
 */
export function priceCart(
  request: QuoteRequest,
  settings: PromotionsSettings,
  loaded: LoadedCart,
  /** Units sold per flash sale; a sale missing here is unknown. */
  sold: ReadonlyMap<Id<'Promotion'>, number> | null,
  customer: CustomerFacts | null,
  code: string | null,
): Result<QuoteResult, PromotionsFailure> {
  const zones = [...new Set(request.shipping.map((charge) => charge.zoneCode))].sort();
  // Units left of each flash sale: its limit less the units sold. A count that cannot be read is
  // unknown: the sale is left out of a real order (fail closed) and counts as sold 0 in a test
  // order only.
  const flashRemaining = new Map<Id<'Promotion'>, number>();
  for (const record of loaded.records) {
    if (record.type !== 'FLASH_SALE') continue;
    const count = sold?.get(record.id) ?? (request.testMode ? 0 : null);
    if (count === null || record.flashUnitLimit === null) continue;
    flashRemaining.set(record.id, Math.max(0, record.flashUnitLimit - count));
  }
  const promotions = promotionsForCart({
    records: loaded.records,
    usage: loaded.usage,
    optIns: loaded.optIns,
    settings,
    firstOrder: loaded.firstOrder,
    firstOrderSpent: loaded.firstOrderSpent,
    customerUses: loaded.customerUses,
    thresholds: new Map(loaded.thresholds.map((row) => [row.zoneCode, row.thresholdMinor])),
    zones,
    testMode: request.testMode,
    flashRemaining,
    batch:
      code === null || loaded.found === null
        ? null
        : {
            promotionId: loaded.found.promotionId,
            code,
            used: loaded.found.usedAt !== null,
          },
  });
  const result = calculateDiscounts(
    toInput(
      { ...request, code },
      settings.currency,
      promotions,
      settings.lineDiscountCapBps,
      customer,
    ),
  );
  if (!result.ok) {
    return err({ code: 'validation.failed', fields: [{ path: result.error.path, code: 'value' }] });
  }
  return ok({ ...result.value, enabled: true });
}

/** The cart with no discount, as a quote with promotions off answers it. */
export function bareQuote(
  request: QuoteRequest,
  currency: string,
): Result<QuoteResult, PromotionsFailure> {
  const bare = calculateDiscounts(
    toInput(request, currency, [], NO_DISCOUNT_RULES.lineDiscountCapBps),
  );
  return bare.ok
    ? ok({ ...bare.value, enabled: false })
    : err({ code: 'validation.failed', fields: [{ path: bare.error.path, code: 'value' }] });
}

/** The shape checks of a quote, before the switch is read. */
export function checkQuoteShape(
  deps: PromotionsDependencies,
  context: CallContext,
  request: QuoteRequest,
): { readonly currency: string; readonly issues: readonly { path: string; code: string }[] } {
  const currency =
    deps.policy.settings(context.market)?.currency ?? request.orderCommission.currency;
  return { currency, issues: checkShape(request, currency) };
}

/** The customer's facts for the audience promotions (another module's reads, outside any unit). */
export const readCustomerFacts = customerFactsOf;

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
  /** The admin preview states the customer's facts itself; the facade reads them from their owners. */
  simulated: CustomerFacts | null = null,
): Promise<Result<QuoteResult, PromotionsFailure>> {
  // The shape of the cart comes first, with the switch on or off: every amount in the Market's
  // currency (when the Market has no settings, in one currency), and the sizes in bounds.
  const shape = checkQuoteShape(deps, context, request);
  if (shape.issues.length > 0) return err({ code: 'validation.failed', fields: shape.issues });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) {
    if (strict) return switched;
    return bareQuote(request, shape.currency);
  }
  const settings = switched.value;
  const now = deps.clock.now();
  const code = request.code === null ? null : normaliseCode(request.code);

  const loaded = await deps.unitOfWork.run(
    context.market,
    async () => ok(await loadCart(deps, context, request, settings, now, code, !strict)),
    { readOnly: true },
  );
  if (!loaded.ok) return err({ code: 'promotions.unavailable' });

  const flash = loaded.value.records.filter((record) => record.type === 'FLASH_SALE');
  const sold =
    flash.length === 0
      ? null
      : await deps.flashSales.soldUnits(
          context,
          flash.map((record) => record.id),
        );
  const customer =
    simulated ?? (await customerFactsOf(deps, context, request, loaded.value.records, now));
  return priceCart(request, settings, loaded.value, sold, customer, code);
}

/** The admin preview takes an admin session (not acting-as); the checkout facade is a system call. */
export const canPreview = (context: CallContext): boolean => adminAccountId(context) !== null;
