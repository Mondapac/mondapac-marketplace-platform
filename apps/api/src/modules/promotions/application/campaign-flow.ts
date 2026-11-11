import { err, ok, parseId, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { floorShare } from '../domain/calculation/allocation';
import type { Reward } from '../domain/calculation/types';
import { platformShareBps, type PromotionRecord } from '../domain/promotion';
import { sellerPayoutPreview, type SellerPayoutPreview } from '../domain/seller-payout';
import { wasPriceEligible } from '../domain/was-price';
import { sellerCaller } from './caller';
import type { FieldIssue, PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';

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
    { records: readonly PromotionRecord[]; mine: ReadonlySet<Id<'Promotion'>> },
    PromotionsFailure
  >(
    context.market,
    async () => {
      const records = await deps.promotions.listOpenCampaigns(context.market, now, seller.sellerId);
      const live = await deps.optIns.liveSellers(
        context.market,
        records.map((record) => record.id),
      );
      const mine = new Set(
        records
          .filter((record) => live.get(record.id)?.includes(seller.sellerId) === true)
          .map((record) => record.id),
      );
      return ok({ records, mine });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;

  const optedAt = new Map<Id<'Promotion'>, Temporal.Instant>();
  if (read.value.mine.size > 0) {
    const stamped = await deps.unitOfWork.run<
      readonly [Id<'Promotion'>, Temporal.Instant][],
      never
    >(
      context.market,
      async () => {
        const pairs: [Id<'Promotion'>, Temporal.Instant][] = [];
        for (const promotionId of read.value.mine) {
          const row = await deps.optIns.find(context.market, promotionId, seller.sellerId);
          if (row !== null && row.withdrawnAt === null) pairs.push([promotionId, row.optedInAt]);
        }
        return ok(pairs);
      },
      { readOnly: true },
    );
    if (stamped.ok) for (const [promotionId, at] of stamped.value) optedAt.set(promotionId, at);
  }

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
    views.push(campaignView(record, now, optedAt.get(record.id) ?? null, soldCount));
  }
  return ok(views);
}

/** What `previewSellerPayout` answers: the money of one sale, and the was-price verdict. */
export interface SellerPayoutPreviewView extends SellerPayoutPreview {
  readonly currency: string;
  readonly commissionRateBps: number;
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

  // The reward and who pays it.
  let reward: Reward;
  let shareBps = 0;
  if (promotionId !== null && promotionId.ok) {
    const campaignId = promotionId.value;
    const found = await deps.unitOfWork.run<PromotionRecord | null, PromotionsFailure>(
      context.market,
      async () => {
        const open = await deps.promotions.listOpenCampaigns(
          context.market,
          deps.clock.now(),
          seller.sellerId,
        );
        return ok(open.find((record) => record.id === campaignId) ?? null);
      },
      { readOnly: true },
    );
    if (!found.ok) return found;
    if (found.value === null) return err({ code: 'promotions.not-found' });
    reward = found.value.reward;
    shareBps = platformShareBps(found.value.funding, found.value.platformSplitBps);
  } else {
    reward = { kind: 'PERCENT', bps: input.discountBps as number };
  }

  // The seller's own commission rate; no rate, no money.
  const rate = await deps.sellerCommission.rateBps(context, seller.sellerId);
  if (rate === null) return err({ code: 'promotions.unavailable' });

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

  const money = sellerPayoutPreview({
    price: price.value,
    reward,
    platformShareBps: shareBps,
    commissionRateBps: rate,
  });
  return ok({ ...money, currency: settings.currency, commissionRateBps: rate, wasPrice });
}
