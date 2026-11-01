import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CreditRecord } from '../domain/credit';
import { isCreditType } from '../domain/promotion';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import type { PromotionsDependencies } from './promotions-dependencies';
import type { CreditCursor } from './ports/credit.repository';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface CreditPage {
  readonly items: readonly CreditRecord[];
  /** Pass as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** An opaque cursor: the creation instant and id of the last row of a page. */
export const encodeCreditCursor = (credit: CreditRecord): string =>
  Buffer.from(`${credit.createdAt.epochMilliseconds}|${credit.id}`, 'utf8').toString('base64url');

export function decodeCreditCursor(text: string): CreditCursor | null {
  if (text.length === 0 || text.length > 120 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const [millis, rest, ...extra] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  if (millis === undefined || rest === undefined || extra.length > 0) return null;
  const parsedId = parseId<'PromotionCredit'>(rest);
  if (!/^\d{1,15}$/.test(millis) || !parsedId.ok) return null;
  return {
    createdAt: Temporal.Instant.fromEpochMilliseconds(Number(millis)),
    id: parsedId.value,
  };
}

/**
 * The credits of one wallet-credit promotion (referral or cashback), newest first, a page at a
 * time (keyset), for an admin with `promotions.promotion.manage`: who was credited how much, in
 * what state, for which order. No name, address or payment detail is in a row. A read: it works
 * while the Market switch is off, so an admin can still see what was paid.
 */
export async function listCredits(
  deps: PromotionsDependencies,
  context: CallContext,
  input: {
    readonly promotionId?: unknown;
    readonly limit?: unknown;
    readonly cursor?: unknown;
  },
): Promise<Result<CreditPage, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  if (deps.policy.settings(context.market) === null) return err({ code: 'promotions.unavailable' });
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
  let after: CreditCursor | undefined;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeCreditCursor(input.cursor) : null;
    if (decoded === null) fields.push({ path: 'cursor', code: 'value' });
    else after = decoded;
  }
  if (fields.length > 0 || id === null || !id.ok) {
    return err({ code: 'validation.failed', fields });
  }
  return deps.unitOfWork.run<CreditPage, PromotionsFailure>(
    context.market,
    async () => {
      const promotion = await deps.promotions.find(context.market, id.value);
      if (promotion === null || !isCreditType(promotion.type)) {
        return err({ code: 'promotions.not-found' });
      }
      const rows = await deps.credits.listForPromotion(
        context.market,
        promotion.id,
        limit + 1,
        after,
      );
      const items = rows.slice(0, limit);
      return ok({
        items,
        nextCursor: rows.length > limit ? encodeCreditCursor(items[items.length - 1]!) : null,
      });
    },
    { readOnly: true },
  );
}
