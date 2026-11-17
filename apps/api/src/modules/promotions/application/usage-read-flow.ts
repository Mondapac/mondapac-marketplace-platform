import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import type { CustomerUsage, UsageCursor } from './ports/redemption.repository';
import type { PromotionsDependencies } from './promotions-dependencies';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface UsagePage {
  readonly items: readonly CustomerUsage[];
  /** Pass as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** An opaque cursor: the reservation instant and id of the last row of a page. */
export const encodeUsageCursor = (usage: CustomerUsage): string =>
  Buffer.from(`${usage.record.reservedAt.epochMilliseconds}|${usage.record.id}`, 'utf8').toString(
    'base64url',
  );

export function decodeUsageCursor(text: string): UsageCursor | null {
  if (text.length === 0 || text.length > 120 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const [millis, rest, ...extra] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  if (millis === undefined || rest === undefined || extra.length > 0) return null;
  const parsedId = parseId<'Redemption'>(rest);
  if (!/^\d{1,15}$/.test(millis) || !parsedId.ok) return null;
  return {
    reservedAt: Temporal.Instant.fromEpochMilliseconds(Number(millis)),
    id: parsedId.value,
  };
}

/**
 * One customer's promotion usages, newest first, a page at a time (keyset), for an admin with
 * `promotions.promotion.view` (the admin customer page, customers management phase 2b item e).
 * Each row is one discount an order took: the promotion (or settings-based offer), the order, the
 * discount and its state. RESERVED rows can still be released; only CONFIRMED ones count as used.
 * No code (only its hash is stored), share split, name or address is in a row. A read: it works
 * while the Market switch is off.
 */
export async function listUsagesOfCustomer(
  deps: PromotionsDependencies,
  context: CallContext,
  input: {
    readonly customerAccountId?: unknown;
    readonly limit?: unknown;
    readonly cursor?: unknown;
  },
): Promise<Result<UsagePage, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  if (deps.policy.settings(context.market) === null) return err({ code: 'promotions.unavailable' });
  const id =
    typeof input?.customerAccountId === 'string'
      ? parseId<'Account'>(input.customerAccountId)
      : null;
  const fields: { path: string; code: string }[] = [];
  if (id === null || !id.ok) fields.push({ path: 'customerAccountId', code: 'value' });
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
  let after: UsageCursor | null = null;
  if (input?.cursor !== undefined) {
    const decoded = typeof input.cursor === 'string' ? decodeUsageCursor(input.cursor) : null;
    if (decoded === null) fields.push({ path: 'cursor', code: 'value' });
    else after = decoded;
  }
  if (fields.length > 0 || id === null || !id.ok) {
    return err({ code: 'validation.failed', fields });
  }
  return deps.unitOfWork.run<UsagePage, PromotionsFailure>(
    context.market,
    async () => {
      const rows = await deps.redemptions.forCustomer(context.market, id.value, limit + 1, after);
      const items = rows.slice(0, limit);
      return ok({
        items,
        nextCursor: rows.length > limit ? encodeUsageCursor(items[items.length - 1]!) : null,
      });
    },
    { readOnly: true },
  );
}
