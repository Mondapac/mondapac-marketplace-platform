import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { QuoteRequest, QuoteResult } from '../contracts/promotions.facade';
import type { CartLine } from '../domain/calculation/types';
import { normaliseCode } from '../domain/promotion';
import {
  budgetMonthOf,
  kindOfKey,
  limitedUnits,
  ORDER_KEY,
  sameDiscounts,
  summaryOf,
  type DiscountSummary,
  type RedemptionRecord,
  type ReleaseReason,
} from '../domain/redemption';
import type { PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import { LockContendedError } from './ports/promotion.repository';
import { RedemptionTakenError, type UsageDelta } from './ports/redemption.repository';
import type { PromotionsDependencies } from './promotions-dependencies';
import {
  bareQuote,
  checkQuoteShape,
  loadCart,
  priceCart,
  readCustomerFacts,
  type LoadedCart,
} from './quote-flow';

// The redemption of an order's discounts (promotions package T2), the step of the checkout saga
// between "the order is stored" and "the payment starts":
//   1. ordering quoted the cart and stored the order with exactly those discounts;
//   2. `redeem` locks the usage rows of the promotions the order took (in id order), reads the facts
//      again under the locks, runs the same calculation and compares it with what the order holds.
//      Equal: the redemption rows are written RESERVED, the counters move and a single-use code is
//      claimed, all in one unit. Different (a budget, a limit or a code was taken meanwhile): nothing
//      is written and the fresh quote is the answer, so the buyer confirms the new total;
//   3. `ordering.order-paid.v1` confirms the rows; `ordering.order-cancelled.v1` releases them and
//      gives back what they took (counters, budget, the code).
// The redemption is idempotent per order: a repeat finds its rows and answers `already-redeemed`.

const logger = new Logger('PromotionsRedemption');

export interface RedeemInput {
  readonly orderId: Id<'Order'>;
  /** The customer the order is for: the per-customer limits count against this account. */
  readonly customerAccountId: Id<'Account'>;
  /** The quote request the order was priced with (its `customerAccountId` is the same account). */
  readonly request: QuoteRequest;
  /** The discounts the stored order holds: {@link summaryOf} of that quote. */
  readonly expected: DiscountSummary;
}

export interface RedeemOutput {
  /** `nothing`: the order took no discount; `already-redeemed`: a repeat for the same order. */
  readonly outcome: 'redeemed' | 'already-redeemed' | 'nothing';
}

export type RedeemFailure =
  | PromotionsFailure
  /** The discounts are not what the order holds any more: nothing was written; `quote` is fresh. */
  | { readonly code: 'promotions.quote-changed'; readonly quote: QuoteResult }
  /** The order's redemption was released already (the order was cancelled): never redeemed again. */
  | { readonly code: 'promotions.redemption-released' }
  /** A row lock could not be taken in time: nothing was written; the caller may try again. */
  | { readonly code: 'conflict.retry' };

const cartLinesOf = (request: QuoteRequest): CartLine[] =>
  request.lines.map((line) => ({
    id: line.id,
    sellerId: line.sellerId,
    productId: line.productId,
    unitPrice: line.unitPrice.amount,
    quantity: line.quantity,
  }));

/** `redeem`: see the module comment above. Rule `system` (ordering's checkout). */
export async function redeem(
  deps: PromotionsDependencies,
  context: CallContext,
  input: RedeemInput,
): Promise<Result<RedeemOutput, RedeemFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const accountId =
    typeof input?.customerAccountId === 'string'
      ? parseId<'Account'>(input.customerAccountId)
      : null;
  if (orderId === null || !orderId.ok || accountId === null || !accountId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] });
  }
  // The per-customer counts are the order's customer's, never an account the request names apart.
  const request: QuoteRequest = { ...input.request, customerAccountId: accountId.value };
  if ((input.request?.customerAccountId ?? accountId.value) !== accountId.value) {
    return err({
      code: 'validation.failed',
      fields: [{ path: 'request.customerAccountId', code: 'mismatch' }],
    });
  }
  const expected = input.expected as DiscountSummary | undefined;
  if (
    !Array.isArray(expected?.applied) ||
    !Array.isArray(expected.lines) ||
    !Array.isArray(expected.shipping)
  ) {
    return err({ code: 'validation.failed', fields: [{ path: 'expected', code: 'format' }] });
  }
  if (
    expected.applied.length === 0 &&
    expected.lines.length === 0 &&
    expected.shipping.length === 0
  ) {
    return ok({ outcome: 'nothing' });
  }
  const shape = checkQuoteShape(deps, context, request);
  if (shape.issues.length > 0) return err({ code: 'validation.failed', fields: shape.issues });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) {
    // Off since the order was priced: the order holds a discount promotions no longer give.
    if (switched.error.code === 'promotions.unavailable') return switched;
    const bare = bareQuote(request, shape.currency);
    return bare.ok ? err({ code: 'promotions.quote-changed', quote: bare.value }) : bare;
  }
  const settings = switched.value;
  const now = deps.clock.now();
  const code = request.code === null ? null : normaliseCode(request.code);

  // The customer's facts come from other modules, so they are read before the unit opens; which
  // of them are needed follows from the live promotions.
  const preview = await deps.unitOfWork.run(
    context.market,
    async () => ok(await loadCart(deps, context, request, settings, now, code, true)),
    { readOnly: true },
  );
  if (!preview.ok) return err({ code: 'promotions.unavailable' });
  const customer = await readCustomerFacts(deps, context, request, preview.value.records, now);

  // Only promotions that are live now are locked: an expected one that is gone fails the
  // comparison below (quote changed) and has no counters to take.
  const live = new Set<string>(preview.value.records.map((record) => record.id));
  const lockIds = input.expected.applied
    .map((applied) => kindOfKey(applied.promotionId))
    .flatMap((key) =>
      key.promotionId !== null && live.has(key.promotionId)
        ? [key.promotionId as Id<'Promotion'>]
        : [],
    );
  const takesFirstOrder = input.expected.applied.some(
    (applied) => kindOfKey(applied.promotionId).kind === 'FIRST_ORDER',
  );

  try {
    return await deps.unitOfWork.run<RedeemOutput, RedeemFailure>(context.market, async () => {
      const existing = await deps.redemptions.forOrder(context.market, orderId.value);
      if (existing.length > 0) return repeated(existing, input.expected);
      // The locks first, then every count read again under them: another order of the same
      // promotion has either committed (and is counted) or waits behind this unit.
      await deps.redemptions.lockUsage(context.market, lockIds, now);
      if (takesFirstOrder && !(await deps.redemptions.lockMarket(context.market))) {
        return err({ code: 'promotions.unavailable' } as const);
      }
      // The first-order discount is once per customer: a live one on another order (two
      // checkouts at once, or an unpaid earlier order) prices this order as not the first.
      const priceAs =
        takesFirstOrder &&
        request.isFirstOrder &&
        (await deps.redemptions.customerFirstOrders(context.market, accountId.value)) > 0
          ? { ...request, isFirstOrder: false }
          : request;
      const loaded = await loadCart(deps, context, priceAs, settings, now, code, true);
      const flashIds = loaded.records
        .filter((record) => record.type === 'FLASH_SALE')
        .map((record) => record.id);
      const sold = await deps.redemptions.unitsSold(context.market, flashIds);
      const priced = priceCart(priceAs, settings, loaded, sold, customer, code);
      if (!priced.ok) return priced;
      if (!sameDiscounts(summaryOf(priced.value), input.expected)) {
        return err({ code: 'promotions.quote-changed' as const, quote: priced.value });
      }
      return write(deps, context, {
        orderId: orderId.value,
        accountId: accountId.value,
        request: priceAs,
        loaded,
        sold,
        priced: priced.value,
        code,
        recalc: (taken: LoadedCart) => priceCart(priceAs, settings, taken, sold, customer, code),
        budgetMonth: budgetMonthOf(now, settings.timeZone),
      });
    });
  } catch (error) {
    if (error instanceof LockContendedError || error instanceof TransactionConflictError) {
      return err({ code: 'conflict.retry' });
    }
    if (!(error instanceof RedemptionTakenError)) throw error;
    // Another redemption of the order, or its cancellation, wrote first: answer as a repeat.
    const after = await deps.unitOfWork.run(
      context.market,
      async () => ok(await deps.redemptions.forOrder(context.market, orderId.value)),
      { readOnly: true },
    );
    if (!after.ok || after.value.length === 0) return err({ code: 'conflict.retry' });
    return repeated(after.value, input.expected);
  }
}

/**
 * The answer to a redemption of an order that has rows: released (it was cancelled), or the same
 * discounts again. Different discounts under the same order id are refused, never hidden.
 */
function repeated(
  rows: readonly RedemptionRecord[],
  expected: DiscountSummary,
): Result<RedeemOutput, RedeemFailure> {
  if (rows.some((row) => row.status === 'RELEASED')) {
    return err({ code: 'promotions.redemption-released' });
  }
  const stored = rows
    .filter((row) => row.kind !== 'ORDER')
    .map((row) => `${row.promotionKey}|${row.amount}|${row.sellerShare}|${row.platformShare}`)
    .sort();
  const asked = expected.applied
    .map((a) => `${a.promotionId}|${a.amount}|${a.sellerShare}|${a.platformShare}`)
    .sort();
  if (stored.join(',') !== asked.join(',')) {
    return err({ code: 'validation.failed', fields: [{ path: 'expected', code: 'mismatch' }] });
  }
  return ok({ outcome: 'already-redeemed' });
}

async function write(
  deps: PromotionsDependencies,
  context: CallContext,
  args: {
    readonly orderId: Id<'Order'>;
    readonly accountId: Id<'Account'>;
    readonly request: QuoteRequest;
    readonly loaded: LoadedCart;
    readonly sold: ReadonlyMap<Id<'Promotion'>, number>;
    readonly priced: QuoteResult;
    readonly code: string | null;
    readonly recalc: (taken: LoadedCart) => Result<QuoteResult, PromotionsFailure>;
    readonly budgetMonth: string;
  },
): Promise<Result<RedeemOutput, RedeemFailure>> {
  const now = deps.clock.now();
  const recordOf = new Map(args.loaded.records.map((record) => [record.id as string, record]));
  const lines = cartLinesOf(args.request);
  // A single-use code the order took is claimed in one statement: of two orders racing for it,
  // the second matches no row and gets the quote without the code.
  let codeHash: string | null = null;
  const found = args.loaded.found;
  if (
    args.code !== null &&
    found !== null &&
    args.priced.applied.some((applied) => applied.promotionId === found.promotionId)
  ) {
    codeHash = deps.codeCrypto.hash(args.code);
    const claimed = await deps.redemptions.claimCode(context.market, codeHash, args.orderId, now);
    if (!claimed) {
      const without = args.recalc({ ...args.loaded, found: { ...found, usedAt: now } });
      return without.ok ? err({ code: 'promotions.quote-changed', quote: without.value }) : without;
    }
  }
  const rows: RedemptionRecord[] = [];
  const deltas: UsageDelta[] = [];
  for (const applied of args.priced.applied) {
    if (applied.amount <= 0n) continue;
    const key = kindOfKey(applied.promotionId);
    const record = key.promotionId === null ? undefined : recordOf.get(key.promotionId);
    const units =
      record?.type === 'FLASH_SALE' && record.flashUnitLimit !== null
        ? limitedUnits(
            lines,
            args.priced,
            record.id,
            Math.max(0, record.flashUnitLimit - (args.sold.get(record.id) ?? 0)),
          )
        : null;
    rows.push({
      id: deps.ids.next<'PromotionRedemption'>(),
      orderId: args.orderId,
      promotionKey: applied.promotionId,
      promotionId: key.promotionId,
      kind: key.kind,
      customerAccountId: args.accountId,
      codeHash: record?.type === 'BATCH_CODE' ? codeHash : null,
      currency: args.priced.currency,
      amount: applied.amount,
      sellerShare: applied.sellerShare,
      platformShare: applied.platformShare,
      units: units !== null && units > 0 ? units : null,
      budgetMonth: key.kind === 'FIRST_ORDER' ? args.budgetMonth : null,
      status: 'RESERVED',
      releaseReason: null,
      reservedAt: now,
      confirmedAt: null,
      releasedAt: null,
    });
    if (key.promotionId !== null) {
      deltas.push({
        promotionId: key.promotionId as Id<'Promotion'>,
        uses: 1,
        spent: applied.amount,
        sellerShare: applied.sellerShare,
        platformShare: applied.platformShare,
      });
    }
  }
  // The head row: the key a cancellation of the order meets (see ORDER_KEY).
  rows.push({
    id: deps.ids.next<'PromotionRedemption'>(),
    orderId: args.orderId,
    promotionKey: ORDER_KEY,
    promotionId: null,
    kind: 'ORDER',
    customerAccountId: args.accountId,
    codeHash: null,
    currency: args.priced.currency,
    amount: 0n,
    sellerShare: 0n,
    platformShare: 0n,
    units: null,
    budgetMonth: null,
    status: 'RESERVED',
    releaseReason: null,
    reservedAt: now,
    confirmedAt: null,
    releasedAt: null,
  });
  await deps.redemptions.insertMany(context.market, rows);
  await deps.redemptions.addUsage(context.market, deltas, now);
  return ok({ outcome: 'redeemed' });
}

export interface RedemptionEventInput {
  readonly delivery: EventDelivery;
  readonly orderId: unknown;
}

export interface RedemptionEventOutput {
  readonly outcome: 'confirmed' | 'released' | 'nothing' | 'already-handled';
}

export type RedemptionEventFailure =
  { readonly code: 'validation.failed' } | { readonly code: 'promotions.try-again' };

const orderIdOf = (value: unknown): Id<'Order'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Order'>(value) : null;
  return parsed === null || !parsed.ok ? null : parsed.value;
};

/**
 * The handler of `ordering.order-paid.v1`: the order's RESERVED redemptions become CONFIRMED.
 * Whatever the switch says now (the discount was given when the order was placed). Idempotent:
 * recorded in the inbox in the same unit.
 */
export async function confirmRedemptions(
  deps: PromotionsDependencies,
  context: CallContext,
  input: RedemptionEventInput,
): Promise<Result<RedemptionEventOutput, RedemptionEventFailure>> {
  const orderId = orderIdOf(input?.orderId);
  if (orderId === null) return err({ code: 'validation.failed' });
  const now = deps.clock.now();
  const marked = await deps.unitOfWork.runOnce(context.market, input.delivery, async () =>
    ok(await deps.redemptions.confirm(context.market, orderId, now)),
  );
  if (!marked.ok) return err({ code: 'promotions.try-again' });
  if (!marked.value.handled) return ok({ outcome: 'already-handled' });
  return ok({ outcome: marked.value.value > 0 ? 'confirmed' : 'nothing' });
}

/**
 * Releases an order's redemptions and gives back what they took: the usage counters (uses, spend,
 * shares), the first-order money (by leaving the rows' sum) and a single-use code. A row released
 * before is not given back twice (it moves only from the status it was read in).
 */
export async function releaseRedemptions(
  deps: PromotionsDependencies,
  context: CallContext,
  input: RedemptionEventInput,
  reason: ReleaseReason,
): Promise<Result<RedemptionEventOutput, RedemptionEventFailure>> {
  const orderId = orderIdOf(input?.orderId);
  if (orderId === null) return err({ code: 'validation.failed' });
  const now = deps.clock.now();
  const marked = await deps.unitOfWork.runOnce(context.market, input.delivery, async () =>
    ok(await releaseInUnit(deps, context, orderId, reason, now)),
  );
  if (!marked.ok) return err({ code: 'promotions.try-again' });
  if (!marked.value.handled) return ok({ outcome: 'already-handled' });
  if (marked.value.value > 0) {
    logger.log({ msg: 'promotions.redemptions-released', orderId, rows: marked.value.value });
  }
  return ok({ outcome: marked.value.value > 0 ? 'released' : 'nothing' });
}

/**
 * Inside the caller's unit: releases the order's rows (the head row first, so a redemption that
 * comes later is refused) and gives back what they took. The number of discount rows released.
 */
async function releaseInUnit(
  deps: PromotionsDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
  reason: ReleaseReason,
  now: Temporal.Instant,
): Promise<number> {
  // The head row first: a cancellation that comes before the redemption leaves it RELEASED, so
  // the redemption is refused; one that comes after (or waits on it) finds the rows below.
  await deps.redemptions.markReleased(
    context.market,
    orderId,
    deps.ids.next<'PromotionRedemption'>(),
    reason,
    now,
  );
  const released = await deps.redemptions.release(context.market, orderId, reason, now, true);
  const deltas: UsageDelta[] = released.flatMap((row) =>
    row.promotionId === null
      ? []
      : [
          {
            promotionId: row.promotionId as Id<'Promotion'>,
            uses: -1,
            spent: -row.amount,
            sellerShare: -row.sellerShare,
            platformShare: -row.platformShare,
          },
        ],
  );
  await deps.redemptions.addUsage(context.market, deltas, now);
  for (const row of released) {
    if (row.codeHash !== null) {
      await deps.redemptions.unclaimCode(context.market, row.codeHash, orderId);
    }
  }
  return released.filter((row) => row.kind !== 'ORDER').length;
}

/** At most this many orders are listed per sweep. */
export const MAX_STALE_ORDERS = 100;

export interface StaleRedemptionsInput {
  /** Orders whose RESERVED rows were written before this instant. */
  readonly before: unknown;
  readonly limit: unknown;
  /** Optional: the last order id of the previous page. */
  readonly after?: unknown;
}

/**
 * The orders that still hold RESERVED redemptions written before `before`, in order id order
 * after `after`: the safety sweep's list, in pages (ordering asks, then settles each by its own
 * order's state). Paging by id lets the sweep pass orders it cannot settle yet. Read only.
 */
export async function staleRedemptions(
  deps: PromotionsDependencies,
  context: CallContext,
  input: StaleRedemptionsInput,
): Promise<Result<readonly Id<'Order'>[], RedemptionEventFailure>> {
  const before = input?.before;
  const limit = input?.limit;
  const after = input?.after === undefined ? null : orderIdOf(input.after);
  if (
    (input?.after !== undefined && after === null) ||
    !(before instanceof Temporal.Instant) ||
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_STALE_ORDERS
  ) {
    return err({ code: 'validation.failed' });
  }
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.redemptions.staleReservations(context.market, before, limit, after)),
    { readOnly: true },
  );
  return read.ok ? read : err({ code: 'promotions.try-again' });
}

export interface SettleRedemptionsInput {
  readonly orderId: unknown;
  /** What became of the order: `paid` confirms its rows, `cancelled` releases them. */
  readonly outcome: unknown;
}

/**
 * The safety sweep's settlement of one order (ordering read its state): `paid` confirms the
 * RESERVED rows, `cancelled` releases them and gives back what they took, as the event handlers
 * do. Both are idempotent: rows move only from the status they were read in.
 */
export async function settleRedemptions(
  deps: PromotionsDependencies,
  context: CallContext,
  input: SettleRedemptionsInput,
): Promise<Result<RedemptionEventOutput, RedemptionEventFailure>> {
  const orderId = orderIdOf(input?.orderId);
  const outcome = input?.outcome;
  if (orderId === null || (outcome !== 'paid' && outcome !== 'cancelled')) {
    return err({ code: 'validation.failed' });
  }
  const now = deps.clock.now();
  const done = await deps.unitOfWork.run(context.market, async () =>
    ok(
      outcome === 'paid'
        ? await deps.redemptions.confirm(context.market, orderId, now)
        : await releaseInUnit(deps, context, orderId, 'ORDER_CANCELLED', now),
    ),
  );
  if (!done.ok) return err({ code: 'promotions.try-again' });
  if (done.value === 0) return ok({ outcome: 'nothing' });
  return ok({ outcome: outcome === 'paid' ? 'confirmed' : 'released' });
}
