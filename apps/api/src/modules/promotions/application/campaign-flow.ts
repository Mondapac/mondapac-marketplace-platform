import { err, ok, parseId, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { floorShare } from '../domain/calculation/allocation';
import { calculateDiscounts } from '../domain/calculation/engine';
import type { Reward } from '../domain/calculation/types';
import { platformShareBps, type PromotionRecord } from '../domain/promotion';
import { ownSaleSplit } from '../domain/seller-payout';
import { wasPriceEligible } from '../domain/was-price';
import { sellerCaller } from './caller';
import type { FieldIssue, PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';
import { promotionsForCart } from './quote-flow';

// A seller's view of the co-funded campaigns it may join, and the preview of what it gets from a
// sale. The seller comes from the session, never from the request. The seller sees its own share
// of a discount and the platform's share as a percentage, never the platform's budget or spend.

/** A campaign a seller may join, as the seller sees it. */
export interface SellerCampaignView {
  readonly id: Id<'Promotion'>;
  readonly name: string;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant | null;
  /** True once the campaign has started; the seller may then no longer leave it on its own. */
  readonly started: boolean;
  readonly testMode: boolean;
  readonly reward: Reward;
  /** The part of the discount the platform pays, in basis points of the discount. */
  readonly platformShareBps: number;
  /** For a percentage reward: what the seller pays and what the platform pays, in basis points of the price. */
  readonly sellerPaysBps: number | null;
  readonly platformPaysBps: number | null;
  readonly minSpendMinor: bigint | null;
  readonly currency: string;
  readonly optedIn: boolean;
  readonly optedInAt: Temporal.Instant | null;
  /**
   * Which of the seller's products the campaign covers: `ALL` (no product is excluded; `count` is
   * null) or `LISTED` (the campaign names products; `count` is how many of them the seller sells,
   * null when that could not be read).
   */
  readonly eligible: { readonly scope: 'ALL' | 'LISTED'; readonly count: number | null };
}

function campaignView(
  record: PromotionRecord,
  now: Temporal.Instant,
  optedInAt: Temporal.Instant | null,
  soldCount: number | null,
): SellerCampaignView {
  const share = platformShareBps(record.funding, record.platformSplitBps);
  const percent = record.reward.kind === 'PERCENT' ? record.reward.bps : null;
  const platformPays = percent === null ? null : Number(floorShare(BigInt(percent), share));
  return {
    id: record.id,
    name: record.name,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    started: record.startsAt.epochMilliseconds <= now.epochMilliseconds,
    testMode: record.testMode,
    reward: record.reward,
    platformShareBps: share,
    sellerPaysBps: percent === null || platformPays === null ? null : percent - platformPays,
    platformPaysBps: platformPays,
    minSpendMinor: record.minSpendMinor,
    currency: record.currency,
    optedIn: optedInAt !== null,
    optedInAt,
    eligible:
      record.productIds.length === 0
        ? { scope: 'ALL', count: null }
        : { scope: 'LISTED', count: soldCount },
  };
}

/** `promotions.list-seller-campaigns`: the open co-funded campaigns, split by opted in or not. */
export async function listSellerCampaigns(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<readonly SellerCampaignView[], PromotionsFailure>> {
  const seller = sellerCaller(context);
  if (seller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const now = deps.clock.now();

  const read = await deps.unitOfWork.run<
    {
      records: readonly PromotionRecord[];
      optedAt: ReadonlyMap<Id<'Promotion'>, Temporal.Instant>;
    },
    PromotionsFailure
  >(
    context.market,
    async () => {
      const records = await deps.promotions.listOpenCampaigns(context.market, now, seller.sellerId);
      const live = await deps.optIns.liveSellers(
        context.market,
        records.map((record) => record.id),
      );
      // One snapshot: who is in and since when, read in the same unit as the campaigns.
      const optedAt = new Map<Id<'Promotion'>, Temporal.Instant>();
      for (const record of records) {
        if (live.get(record.id)?.includes(seller.sellerId) !== true) continue;
        const row = await deps.optIns.find(context.market, record.id, seller.sellerId);
        if (row !== null && row.withdrawnAt === null) optedAt.set(record.id, row.optedInAt);
      }
      return ok({ records, optedAt });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;

  // The catalogue is another module's read: outside any unit, one question per campaign that
  // names products.
  const views: SellerCampaignView[] = [];
  for (const record of read.value.records) {
    let soldCount: number | null = null;
    if (record.productIds.length > 0) {
      const sold = await deps.sellerCatalogue.sellsProducts(
        context,
        seller.sellerId,
        record.productIds,
      );
      soldCount = sold === null ? null : record.productIds.filter((id) => sold.has(id)).length;
    }
    views.push(campaignView(record, now, read.value.optedAt.get(record.id) ?? null, soldCount));
  }
  return ok(views);
}

/** What `previewSellerPayout` answers: the money of one sale, and the was-price verdict. */
export interface SellerPayoutPreviewView {
  readonly currency: string;
  readonly price: bigint;
  readonly discount: bigint;
  /** The part of the discount the seller pays. */
  readonly sellerFunded: bigint;
  /** The part of the discount the platform pays. */
  readonly platformFunded: bigint;
  readonly shopperPays: bigint;
  readonly commissionRateBps: number;
  /** The price less the seller-funded part, less provisional tax when prices include tax. */
  readonly commissionBase: bigint;
  readonly commission: bigint;
  /** Before delivery. */
  readonly sellerGets: bigint;
  /** Null when no Offer was asked about. */
  readonly wasPrice: { readonly eligible: boolean } | null;
}

interface PreviewInput {
  readonly promotionId?: unknown;
  readonly discountBps?: unknown;
  readonly priceMinor?: unknown;
  readonly offerId?: unknown;
  readonly variantId?: unknown;
}

const MAX_PRICE = 10n ** 12n;

/**
 * `promotions.preview-seller-payout`: for one unit at a price, what the shopper pays and what the
 * seller gets, with the seller's own commission rate. Either `promotionId` (a campaign the seller
 * may join) or `discountBps` (the seller's own percentage sale price). With `offerId` and
 * `variantId` of the seller's own sell unit it also says whether the price it has now may show as
 * a struck-through earlier price once the sale starts. Money is shown only when the commission
 * rate is known; a rate that cannot be read is `promotions.unavailable`.
 */
export async function previewSellerPayout(
  deps: PromotionsDependencies,
  context: CallContext,
  input: PreviewInput,
): Promise<Result<SellerPayoutPreviewView, PromotionsFailure>> {
  const seller = sellerCaller(context);
  if (seller === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;

  const issues: FieldIssue[] = [];
  const price = typeof input?.priceMinor === 'string' ? parseMinorUnits(input.priceMinor) : null;
  if (price === null || !price.ok || price.value < 1n || price.value > MAX_PRICE) {
    issues.push({ path: 'priceMinor', code: 'value' });
  }
  const hasCampaign = input?.promotionId !== undefined;
  const hasOwn = input?.discountBps !== undefined;
  if (hasCampaign === hasOwn) {
    issues.push({ path: hasCampaign ? 'discountBps' : 'promotionId', code: 'one-of' });
  }
  const promotionId =
    hasCampaign && typeof input.promotionId === 'string'
      ? parseId<'Promotion'>(input.promotionId)
      : null;
  if (hasCampaign && (promotionId === null || !promotionId.ok)) {
    issues.push({ path: 'promotionId', code: 'value' });
  }
  if (
    hasOwn &&
    (typeof input.discountBps !== 'number' ||
      !Number.isInteger(input.discountBps) ||
      input.discountBps < 1 ||
      input.discountBps > settings.rules.sellerMaxDiscountBps)
  ) {
    issues.push({ path: 'discountBps', code: 'value' });
  }
  const askUnit = input?.offerId !== undefined || input?.variantId !== undefined;
  const offerId =
    askUnit && typeof input.offerId === 'string' ? parseId<'Offer'>(input.offerId) : null;
  const variantId =
    askUnit && typeof input.variantId === 'string' ? parseId<'Variant'>(input.variantId) : null;
  if (askUnit && (offerId === null || !offerId.ok)) issues.push({ path: 'offerId', code: 'value' });
  if (askUnit && (variantId === null || !variantId.ok)) {
    issues.push({ path: 'variantId', code: 'value' });
  }
  if (issues.length > 0 || price === null || !price.ok) {
    return err({ code: 'validation.failed', fields: issues });
  }

  // The seller's own commission on the full price: the order commission that limits what the
  // platform may pay of a discount (the engine's rule), and the check that a rate is readable.
  const gross = await deps.sellerCommission.commissionOn(
    context,
    price.value,
    settings.pricesIncludeTax,
  );
  if (gross === null) return err({ code: 'promotions.unavailable' });

  // The discount and who pays it.
  let split: { discount: bigint; sellerFunded: bigint; platformFunded: bigint };
  if (promotionId !== null && promotionId.ok) {
    const campaignId = promotionId.value;
    const found = await deps.unitOfWork.run<{ record: PromotionRecord } | null, PromotionsFailure>(
      context.market,
      async () => {
        const open = await deps.promotions.listOpenCampaigns(
          context.market,
          deps.clock.now(),
          seller.sellerId,
          campaignId,
        );
        const record = open[0];
        if (record === undefined) return ok(null);
        return ok({ record });
      },
      { readOnly: true },
    );
    if (!found.ok) return found;
    if (found.value === null) return err({ code: 'promotions.not-found' });
    // The platform budget and its spend are not the seller's to learn: the preview calculates
    // as if the campaign had no budget, so a very large price cannot reveal what is left of it.
    const record: PromotionRecord = { ...found.value.record, budgetMinor: null };
    // The real calculation, on a cart of one unit of this seller: its caps, its budget, the
    // seller share limit and the commission limit are the ones a real order meets. A campaign
    // that would not apply (platform money before the tax ruling, a minimum spend the price does
    // not reach) gives no discount, as it would at checkout.
    const promotions = promotionsForCart({
      records: [record],
      usage: new Map(),
      optIns: new Map([[record.id, [seller.sellerId]]]),
      settings,
      firstOrder: null,
      thresholds: new Map(),
      zones: [],
      testMode: record.testMode,
    });
    const calculated = calculateDiscounts({
      currency: settings.currency,
      lines: [
        {
          id: 'preview',
          sellerId: seller.sellerId,
          productId: record.productIds[0] ?? deps.ids.next<'Product'>(),
          unitPrice: price.value,
          quantity: 1,
        },
      ],
      shipping: [],
      promotions,
      code: null,
      isFirstOrder: false,
      customer: null,
      orderCommission: gross.commission,
      rules: { lineDiscountCapBps: settings.lineDiscountCapBps },
    });
    if (!calculated.ok) return err({ code: 'promotions.unavailable' });
    const totals = calculated.value.totals;
    split = {
      discount: totals.goodsDiscount,
      sellerFunded: totals.sellerShare,
      platformFunded: totals.platformShare,
    };
  } else {
    split = ownSaleSplit(price.value, input.discountBps as number);
  }

  // The commission is on the price after the seller-funded part (plan decision 2).
  const commission =
    split.sellerFunded === 0n
      ? gross
      : await deps.sellerCommission.commissionOn(
          context,
          price.value - split.sellerFunded,
          settings.pricesIncludeTax,
        );
  if (commission === null) return err({ code: 'promotions.unavailable' });

  // The was-price verdict, only for the seller's own sell unit.
  let wasPrice: { readonly eligible: boolean } | null = null;
  if (askUnit && offerId !== null && offerId.ok && variantId !== null && variantId.ok) {
    const owns = await deps.sellerCatalogue.ownsSellUnit(
      context,
      seller.sellerId,
      offerId.value,
      variantId.value,
    );
    // Someone else's Offer, an unknown one and an unreadable catalogue are one answer.
    if (!owns) return err({ code: 'promotions.not-found' });
    let days: number | null;
    try {
      days = await deps.priceHistory.daysSoldAtPrice(
        context,
        { offerId: offerId.value, variantId: variantId.value },
        { amount: price.value, currency: settings.currency },
        settings.wasPrice.windowDays,
      );
    } catch {
      days = null;
    }
    wasPrice = { eligible: wasPriceEligible(days, settings.wasPrice) };
  }

  return ok({
    currency: settings.currency,
    price: price.value,
    discount: split.discount,
    sellerFunded: split.sellerFunded,
    platformFunded: split.platformFunded,
    shopperPays: price.value - split.discount,
    commissionRateBps: commission.rateBps,
    commissionBase: commission.commissionBase,
    commission: commission.commission,
    sellerGets: commission.commissionBase - commission.commission,
    wasPrice,
  });
}
