import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { PROMOTION_STATUSES, type PromotionRecord } from '../domain/promotion';
import { wasPriceEligible } from '../domain/was-price';
import { adminAccountId, sellerCaller } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { PromotionFilter, UsageRecord } from './ports/promotion.repository';
import type { PromotionsDependencies } from './promotions-dependencies';
import {
  ownViewOf,
  promotionViewOf,
  usageViewOf,
  type OwnPromotionView,
  type PromotionUsageView,
  type PromotionView,
} from './views';

// The reads of promotions. The Viewer's list carries usage counts only; the admin's carries
// terms, budget and the money used; a seller sees its own promotions with its own money.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface ListInput {
  readonly status?: unknown;
  readonly limit?: unknown;
}

function filterOf(
  input: ListInput,
): Result<Omit<PromotionFilter, 'ownerSellerId'>, PromotionsFailure> {
  const fields: { path: string; code: string }[] = [];
  let status: PromotionFilter['status'];
  if (input?.status !== undefined) {
    if (
      typeof input.status === 'string' &&
      (PROMOTION_STATUSES as readonly string[]).includes(input.status)
    ) {
      status = input.status as PromotionFilter['status'];
    } else {
      fields.push({ path: 'status', code: 'value' });
    }
  }
  let limit = DEFAULT_LIMIT;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_LIMIT
    ) {
      fields.push({ path: 'limit', code: 'value' });
    } else {
      limit = input.limit;
    }
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok(status === undefined ? { limit } : { status, limit });
}

async function listWith<V>(
  deps: PromotionsDependencies,
  context: CallContext,
  input: ListInput,
  scope: { readonly ownerSellerId?: PromotionFilter['ownerSellerId'] },
  view: (record: PromotionRecord, usage: UsageRecord | undefined) => V,
): Promise<Result<readonly V[], PromotionsFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const filter = filterOf(input);
  if (!filter.ok) return filter;
  return deps.unitOfWork.run<readonly V[], PromotionsFailure>(
    context.market,
    async () => {
      const records = await deps.promotions.list(context.market, { ...filter.value, ...scope });
      const usage = await deps.promotions.usageOf(
        context.market,
        records.map((record) => record.id),
      );
      return ok(records.map((record) => view(record, usage.get(record.id))));
    },
    { readOnly: true },
  );
}

/** `promotions.promotion.view`: the list with usage counts only. */
export async function listUsage(
  deps: PromotionsDependencies,
  context: CallContext,
  input: ListInput,
): Promise<Result<readonly PromotionUsageView[], PromotionsFailure>> {
  return listWith(deps, context, input, {}, usageViewOf);
}

/** `promotions.promotion.manage`: the list with terms, budget and the money used. */
export async function listFull(
  deps: PromotionsDependencies,
  context: CallContext,
  input: ListInput,
): Promise<Result<readonly PromotionView[], PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  return listWith(deps, context, input, {}, promotionViewOf);
}

export async function listOwn(
  deps: PromotionsDependencies,
  context: CallContext,
  input: ListInput,
): Promise<Result<readonly OwnPromotionView[], PromotionsFailure>> {
  const seller = sellerCaller(context);
  if (seller === null) return err({ code: 'access.denied' });
  return listWith(deps, context, input, { ownerSellerId: seller.sellerId }, ownViewOf);
}

export async function viewOne(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown },
): Promise<Result<PromotionView, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const id =
    typeof input?.promotionId === 'string' ? parseId<'Promotion'>(input.promotionId) : null;
  if (id === null || !id.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'promotionId', code: 'value' }] });
  }
  return deps.unitOfWork.run<PromotionView, PromotionsFailure>(
    context.market,
    async () => {
      const record = await deps.promotions.find(context.market, id.value);
      if (record === null) return err({ code: 'promotions.not-found' });
      const usage = await deps.promotions.usageOf(context.market, [record.id]);
      return ok(promotionViewOf(record, usage.get(record.id)));
    },
    { readOnly: true },
  );
}

/**
 * Whether a product may show a struck-through earlier price (the was-price rule): decided from the
 * product's price history, never from what a seller types. Unknown history is "not eligible".
 */
export async function checkWasPrice(
  deps: PromotionsDependencies,
  context: CallContext,
  input: {
    readonly productId: string;
    readonly price: { readonly amountMinor: bigint; readonly currency: string };
  },
): Promise<Result<{ readonly eligible: boolean }, PromotionsFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const productId = parseId<'Product'>(input.productId);
  if (!productId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'productId', code: 'value' }] });
  }
  if (input.price.currency !== settings.currency || input.price.amountMinor < 1n) {
    return err({ code: 'validation.failed', fields: [{ path: 'price', code: 'value' }] });
  }
  let days: number | null;
  try {
    days = await deps.priceHistory.daysSoldAtPrice(
      context,
      productId.value,
      { amount: input.price.amountMinor, currency: input.price.currency },
      settings.wasPrice.windowDays,
    );
  } catch {
    // A history that cannot be read is not a yes.
    days = null;
  }
  return ok({ eligible: wasPriceEligible(days, settings.wasPrice) });
}
