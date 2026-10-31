import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CreditRecord } from '../domain/credit';
import { isCreditType } from '../domain/promotion';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The credits of one wallet-credit promotion (referral or cashback), newest first, for an admin
 * with `promotions.promotion.manage`: who was credited how much, in what state, for which order.
 * No name, address or payment detail is in a row.
 */
export async function listCredits(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly promotionId?: unknown; readonly limit?: unknown },
): Promise<Result<readonly CreditRecord[], PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const id =
    typeof input?.promotionId === 'string' ? parseId<'Promotion'>(input.promotionId) : null;
  const fields: { path: string; code: string }[] = [];
  if (id === null || !id.ok) fields.push({ path: 'promotionId', code: 'value' });
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
  if (fields.length > 0 || id === null || !id.ok) {
    return err({ code: 'validation.failed', fields });
  }
  return deps.unitOfWork.run<readonly CreditRecord[], PromotionsFailure>(
    context.market,
    async () => {
      const promotion = await deps.promotions.find(context.market, id.value);
      if (promotion === null || !isCreditType(promotion.type)) {
        return err({ code: 'promotions.not-found' });
      }
      return ok(await deps.credits.listForPromotion(context.market, promotion.id, limit));
    },
    { readOnly: true },
  );
}
