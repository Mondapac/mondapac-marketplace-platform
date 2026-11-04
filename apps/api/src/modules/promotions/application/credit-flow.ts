import { Logger } from '@nestjs/common';
import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import {
  cashbackAmount,
  creditKey,
  creditModeFor,
  type CreditMode,
  type CreditRecord,
  type ReferralRecord,
  type ReferralRejectReason,
} from '../domain/credit';
import type { PromotionRecord } from '../domain/promotion';
import type { PromotionsDependencies } from './promotions-dependencies';
import type { PromotionsSettings } from './ports/promotions-policy';
import type { DeliveredSellerOrderFacts } from './ports/order-facts';
import { locked } from './shared';

// Wallet credit after a delivery (promotions phase 3): cashback and the refer-a-friend reward.
// Both are triggered by `ordering.seller-order-delivered.v1` through the inbox, each by its own
// subscriber, and both are idempotent: the event is recorded in the inbox in the unit that settles
// the credit, the credit is one row per source (unique), and the wallet is called with a key
// derived from that source.
//
// The order of work, for each delivery:
//   1. read-only: the switch, the live promotions of the type, and any credit already made;
//   2. outside a unit: the order's facts (another module);
//   3. one unit: lock the promotion, check its limits, reserve the credit (PENDING) in the same
//      unit that spends no outside call;
//   4. outside a unit: the wallet, with the credit's idempotency key;
//   5. `runOnce`: settle the credit (GRANTED or FAILED) and record the event as handled.
// A crash anywhere repeats the delivery: step 1 finds the reserved credit and carries on from step
// 4, and the wallet answers the first result again for the same key.
//
// A credit already reserved (PENDING) is always finished, whatever the switch or the programs say
// now: the money was committed in a unit that has already run, so only NEW reservations are gated
// on the switch and on a live program.
//
// A test-mode promotion only records the intended credit (status RECORDED) and never calls the
// wallet; platform money in a Market whose tax ruling is not confirmed, and a test order, earn
// nothing (see `creditModeFor`). A RECORDED credit is a note, not a claim: it is chosen only when
// no real promotion applies, holds no budget, counts toward no limit, and (for a referral) leaves
// the referral PENDING, so a real program can still reward it later.

const logger = new Logger('PromotionsCredits');

export type CreditFlowFailure =
  | { readonly code: 'validation.failed' }
  /** A temporary fault (a fact or the wallet is not available yet): the delivery is retried. */
  | { readonly code: 'promotions.try-again' };

export interface CreditFlowOutput {
  readonly outcome:
    | 'issued'
    | 'recorded'
    | 'failed'
    | 'nothing'
    | 'already-handled'
    | 'pending'
    | 'rejected'
    | 'expired';
}

export interface DeliveryInput {
  readonly delivery: EventDelivery;
  readonly orderId: unknown;
  readonly sellerOrderId: unknown;
}

const tryAgain = (): Result<never, CreditFlowFailure> => err({ code: 'promotions.try-again' });

function idsOf(
  input: DeliveryInput,
): { orderId: Id<'Order'>; sellerOrderId: Id<'SellerOrder'> } | null {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  if (orderId === null || !orderId.ok || sellerOrderId === null || !sellerOrderId.ok) return null;
  return { orderId: orderId.value, sellerOrderId: sellerOrderId.value };
}

/** Records the event as handled with no work (nothing to do for it). */
async function handled(
  deps: PromotionsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  outcome: CreditFlowOutput['outcome'],
): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
  const marked = await deps.unitOfWork.runOnce(context.market, delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) return tryAgain();
  return ok({ outcome: marked.value.handled ? outcome : 'already-handled' });
}

/**
 * The settings while promotions are on. Off, or a Market without promotions settings, is "nothing
 * to do" (the event is handled); a switch that cannot be read is a fault (retry).
 */
async function switchState(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<'off' | 'fault' | PromotionsSettings> {
  const settings = deps.policy.settings(context.market);
  if (settings === null) return 'off';
  const row = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.settings.find(context.market)),
    { readOnly: true },
  );
  if (!row.ok) return 'fault';
  return row.value !== null && row.value.status === 'active' ? settings : 'off';
}

const isLive = (record: PromotionRecord, now: Temporal.Instant): boolean =>
  record.status === 'ACTIVE' &&
  record.startsAt.epochMilliseconds <= now.epochMilliseconds &&
  (record.endsAt === null || record.endsAt.epochMilliseconds > now.epochMilliseconds);

function toWalletRequest(credit: CreditRecord) {
  return {
    accountId: credit.recipientAccountId,
    amount: money(credit.amountMinor, credit.currency),
    orderId: credit.orderId,
    idempotencyKey: credit.idempotencyKey,
  };
}

/**
 * Calls the wallet for every PENDING credit, in order, outside any unit. A retryable refusal
 * stops the whole delivery (it is retried; the credits stay reserved); a final refusal settles
 * that credit as FAILED. Returns what to settle, or null when the delivery must be retried.
 */
async function grantPending(
  deps: PromotionsDependencies,
  context: CallContext,
  credits: readonly CreditRecord[],
): Promise<
  | readonly {
      readonly id: Id<'PromotionCredit'>;
      readonly result:
        | { readonly status: 'GRANTED'; readonly walletJournalId: string }
        | { readonly status: 'FAILED'; readonly failureCode: string };
    }[]
  | null
> {
  const settlements = [];
  for (const credit of credits) {
    if (credit.status !== 'PENDING') continue;
    const granted = await deps.walletCredit.grant(context, toWalletRequest(credit));
    if (granted.ok) {
      settlements.push({
        id: credit.id,
        result: { status: 'GRANTED' as const, walletJournalId: granted.value.journalId },
      });
    } else if (granted.error.retry) {
      logger.warn({
        msg: 'promotions.credit.wallet-retry',
        creditId: credit.id,
        code: granted.error.code,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return null;
    } else {
      settlements.push({
        id: credit.id,
        result: { status: 'FAILED' as const, failureCode: granted.error.code },
      });
    }
  }
  return settlements;
}

/** Settles the credits and records the event, in the one `runOnce` unit. */
async function settleAndHandle(
  deps: PromotionsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  settlements: Awaited<ReturnType<typeof grantPending>> & object,
  outcome: CreditFlowOutput['outcome'],
): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
  const now = deps.clock.now();
  const marked = await deps.unitOfWork.runOnce(context.market, delivery, async () => {
    for (const settlement of settlements) {
      await deps.credits.settle(context.market, settlement.id, settlement.result, now);
    }
    return ok(undefined);
  });
  if (!marked.ok) return tryAgain();
  if (!marked.value.handled) return ok({ outcome: 'already-handled' });
  return ok({
    outcome: settlements.some((s) => s.result.status === 'FAILED') ? 'failed' : outcome,
  });
}

/** What the delivery reports for credits that need no wallet call (all settled or recorded). */
function outcomeOfSettled(credits: readonly CreditRecord[]): CreditFlowOutput['outcome'] {
  if (credits.some((c) => c.status === 'FAILED')) return 'failed';
  if (credits.some((c) => c.status === 'GRANTED')) return 'issued';
  if (credits.some((c) => c.status === 'RECORDED')) return 'recorded';
  return 'nothing';
}

/**
 * Finishes credits that were reserved by an earlier attempt: calls the wallet for the PENDING
 * ones and settles them, or records the event when nothing is left to do. Needs no switch and no
 * live program (see the header).
 */
async function finishReserved(
  deps: PromotionsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  credits: readonly CreditRecord[],
): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
  if (credits.some((c) => c.status === 'PENDING')) {
    const settlements = await grantPending(deps, context, credits);
    if (settlements === null) return tryAgain();
    return settleAndHandle(deps, context, delivery, settlements, 'issued');
  }
  return handled(deps, context, delivery, outcomeOfSettled(credits));
}

// ---------------------------------------------------------------------------------------------
// Cashback
// ---------------------------------------------------------------------------------------------

/**
 * The best cashback among the live promotions for this order, reserved in the caller's unit. A
 * real promotion (the wallet is credited) always wins over a test-mode one (the intended credit
 * is only recorded): the test-mode credit is made only when no real promotion applies.
 */
async function reserveCashback(
  deps: PromotionsDependencies,
  context: CallContext,
  settings: PromotionsSettings,
  live: readonly PromotionRecord[],
  facts: DeliveredSellerOrderFacts,
): Promise<Result<CreditRecord | null, CreditFlowFailure>> {
  const now = deps.clock.now();
  const goods = facts.goodsPaid.amount;
  // The Market's limits as they are now: a promotion made under wider limits is clamped.
  const limits = settings.rules.cashback ?? null;
  if (limits === null) return ok(null);
  interface Choice {
    readonly promotion: PromotionRecord;
    readonly amount: bigint;
    readonly mode: CreditMode;
  }
  const best: { REAL: Choice | null; RECORD: Choice | null } = { REAL: null, RECORD: null };
  // Locked in id order, so two handlers never wait on each other in a circle.
  for (const candidate of [...live].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const lock = await locked(() => deps.promotions.findForUpdate(context.market, candidate.id));
    if (!lock.ok) return tryAgain();
    const promotion = lock.value;
    if (
      promotion === null ||
      promotion.type !== 'CASHBACK' ||
      !isLive(promotion, now) ||
      promotion.currency !== settings.currency ||
      promotion.reward.kind !== 'PERCENT' ||
      promotion.capMinor === null
    ) {
      continue;
    }
    const mode = creditModeFor({
      promotionTestMode: promotion.testMode,
      orderIsTest: facts.testOrder,
      gstRulingConfirmed: settings.rules.gstRulingConfirmed,
    });
    if (mode === 'SKIP') continue;
    if (
      promotion.maxTotalUses !== null &&
      (await deps.credits.countLive(context.market, promotion.id)) >= promotion.maxTotalUses
    ) {
      continue;
    }
    if (
      promotion.maxUsesPerCustomer !== null &&
      (await deps.credits.countLive(context.market, promotion.id, facts.customerAccountId)) >=
        promotion.maxUsesPerCustomer
    ) {
      continue;
    }
    const reserved = await deps.credits.reservedTotal(context.market, promotion.id);
    const amount = cashbackAmount({
      goodsPaid: goods,
      bps: Math.min(promotion.reward.bps, limits.maxBps),
      capMinor: promotion.capMinor < limits.maxCapMinor ? promotion.capMinor : limits.maxCapMinor,
      alreadyCreditedForOrder: await deps.credits.creditedForOrder(
        context.market,
        facts.orderId,
        'CASHBACK',
      ),
      minSpendMinor: promotion.minSpendMinor,
      budgetLeft:
        promotion.budgetMinor === null
          ? null
          : promotion.budgetMinor > reserved
            ? promotion.budgetMinor - reserved
            : 0n,
    });
    if (amount <= 0n) continue;
    // The larger credit for the customer; a tie goes to the smaller promotion id (already sorted).
    const current = best[mode];
    if (current === null || amount > current.amount) best[mode] = { promotion, amount, mode };
  }
  const chosen = best.REAL ?? best.RECORD;
  if (chosen === null) return ok(null);
  const record: CreditRecord = {
    id: deps.ids.next<'PromotionCredit'>(),
    promotionId: chosen.promotion.id,
    kind: 'CASHBACK',
    recipientAccountId: facts.customerAccountId,
    orderId: facts.orderId,
    sourceKind: 'SELLER_ORDER',
    sourceId: facts.sellerOrderId,
    amountMinor: chosen.amount,
    currency: settings.currency,
    status: chosen.mode === 'RECORD' ? 'RECORDED' : 'PENDING',
    failureCode: null,
    walletJournalId: null,
    idempotencyKey: creditKey('CASHBACK', facts.sellerOrderId),
    createdAt: now,
    settledAt: chosen.mode === 'RECORD' ? now : null,
  };
  if ((await deps.credits.insert(context.market, record)) === 'duplicate') {
    return ok(await deps.credits.findBySource(context.market, 'CASHBACK', facts.sellerOrderId));
  }
  return ok(record);
}

/**
 * `cashback-on-delivery`, for `ordering.seller-order-delivered.v1`: credits the customer's wallet
 * with the best live cashback promotion's percent of the goods the delivered seller order was paid
 * with, within the promotion's per-order cap, budget and limits. Once per seller order.
 */
export async function cashbackOnDelivery(
  deps: PromotionsDependencies,
  context: CallContext,
  input: DeliveryInput,
): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
  const ids = idsOf(input);
  if (ids === null) return err({ code: 'validation.failed' });
  const { market } = context;

  // A credit made by an earlier attempt is finished first, whatever the switch and the programs
  // say now. A RECORDED note does not count: a real promotion may still apply.
  const found = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.credits.findBySource(market, 'CASHBACK', ids.sellerOrderId)),
    { readOnly: true },
  );
  if (!found.ok) return tryAgain();
  const existing = found.value;
  if (existing !== null && existing.status !== 'RECORDED') {
    return finishReserved(deps, context, input.delivery, [existing]);
  }
  const noted = (): Promise<Result<CreditFlowOutput, CreditFlowFailure>> =>
    handled(deps, context, input.delivery, existing === null ? 'nothing' : 'recorded');

  const settings = await switchState(deps, context);
  if (settings === 'fault') return tryAgain();
  if (settings === 'off') return noted();

  const live = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.promotions.listLiveOfTypes(market, deps.clock.now(), ['CASHBACK'])),
    { readOnly: true },
  );
  if (!live.ok) return tryAgain();
  if (live.value.length === 0) return noted();
  const facts = await deps.orderFacts.read(context, ids);
  if (!facts.known) {
    logger.warn({
      msg: 'promotions.cashback.facts-unknown',
      sellerOrderId: ids.sellerOrderId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return tryAgain();
  }
  if (
    facts.value.sellerOrderId !== ids.sellerOrderId ||
    facts.value.orderId !== ids.orderId ||
    facts.value.goodsPaid.currency !== settings.currency
  ) {
    return noted();
  }
  const reserved = await deps.unitOfWork.run(market, () =>
    reserveCashback(deps, context, settings, live.value, facts.value),
  );
  if (!reserved.ok) return reserved;
  if (reserved.value === null) return noted();
  return finishReserved(deps, context, input.delivery, [reserved.value]);
}

// ---------------------------------------------------------------------------------------------
// Refer a friend
// ---------------------------------------------------------------------------------------------

type Qualification =
  | {
      readonly kind: 'credits';
      readonly credits: readonly CreditRecord[];
      readonly mode: CreditMode;
    }
  | { readonly kind: 'decided'; readonly outcome: 'rejected' | 'expired' }
  | { readonly kind: 'nothing' };

/**
 * Decides a pending referral inside the caller's unit: expiry, the promotion's caps, its budget,
 * then the two credits (the referrer's and the new customer's) reserved together, or a rejection.
 * In test mode (RECORD) the intended credits are only noted and the referral is left PENDING: it
 * is not counted toward the referrer's cap, and a real program may still reward it.
 */
async function qualifyInUnit(
  deps: PromotionsDependencies,
  context: CallContext,
  settings: PromotionsSettings,
  referral: ReferralRecord,
  facts: DeliveredSellerOrderFacts,
): Promise<Result<Qualification, CreditFlowFailure>> {
  const { market } = context;
  const now = deps.clock.now();
  const lock = await locked(() => deps.promotions.findForUpdate(market, referral.promotionId));
  if (!lock.ok) return tryAgain();
  const promotion = lock.value;
  // The Market's limits as they are now: a promotion made under wider limits is clamped.
  const limits = settings.rules.referral ?? null;
  if (
    limits === null ||
    promotion === null ||
    promotion.type !== 'REFERRAL' ||
    !isLive(promotion, now) ||
    promotion.currency !== settings.currency ||
    promotion.reward.kind !== 'FIXED' ||
    promotion.refereeRewardMinor === null ||
    promotion.maxUsesPerCustomer === null
  ) {
    // The program is paused, ended or malformed: the referral waits (it expires on its own).
    return ok({ kind: 'nothing' });
  }
  const mode = creditModeFor({
    promotionTestMode: promotion.testMode,
    orderIsTest: facts.testOrder,
    gstRulingConfirmed: settings.rules.gstRulingConfirmed,
  });
  if (mode === 'SKIP') return ok({ kind: 'nothing' });
  if (promotion.minSpendMinor !== null && facts.goodsPaid.amount < promotion.minSpendMinor) {
    return ok({ kind: 'nothing' });
  }
  const record = mode === 'RECORD';
  // A test-mode run decides nothing about the referral, so it neither rejects nor qualifies it.
  const reject = async (reason: ReferralRejectReason) => {
    if (record) return ok({ kind: 'nothing' } as const);
    await deps.referrals.decide(market, referral.id, { status: 'REJECTED', reason }, now);
    return ok({ kind: 'decided', outcome: 'rejected' } as const);
  };
  if (
    (await deps.referrals.countByReferrer(
      market,
      referral.referrerAccountId,
      promotion.id,
      'QUALIFIED',
    )) >= promotion.maxUsesPerCustomer ||
    (promotion.maxTotalUses !== null &&
      (await deps.referrals.countByPromotion(market, promotion.id, 'QUALIFIED')) >=
        promotion.maxTotalUses)
  ) {
    return reject('CAP_REACHED');
  }
  const referrerAmount =
    promotion.reward.amount < limits.maxRewardMinor
      ? promotion.reward.amount
      : limits.maxRewardMinor;
  const refereeAmount =
    promotion.refereeRewardMinor < limits.maxRewardMinor
      ? promotion.refereeRewardMinor
      : limits.maxRewardMinor;
  const reserved = await deps.credits.reservedTotal(market, promotion.id);
  if (
    promotion.budgetMinor !== null &&
    promotion.budgetMinor - reserved < referrerAmount + refereeAmount
  ) {
    return reject('BUDGET_EXHAUSTED');
  }
  if (!record) {
    const decided = await deps.referrals.decide(
      market,
      referral.id,
      { status: 'QUALIFIED', orderId: facts.orderId, sellerOrderId: facts.sellerOrderId },
      now,
    );
    if (!decided) return ok({ kind: 'nothing' });
  }
  const credit = (
    kind: 'REFERRER_REWARD' | 'REFEREE_REWARD',
    recipient: Id<'Account'>,
    amount: bigint,
  ): CreditRecord => ({
    id: deps.ids.next<'PromotionCredit'>(),
    promotionId: promotion.id,
    kind,
    recipientAccountId: recipient,
    orderId: facts.orderId,
    sourceKind: 'REFERRAL',
    sourceId: referral.id,
    amountMinor: amount,
    currency: settings.currency,
    status: record ? 'RECORDED' : 'PENDING',
    failureCode: null,
    walletJournalId: null,
    idempotencyKey: creditKey(kind, referral.id),
    createdAt: now,
    settledAt: record ? now : null,
  });
  const records = [
    credit('REFERRER_REWARD', referral.referrerAccountId, referrerAmount),
    credit('REFEREE_REWARD', referral.refereeAccountId, refereeAmount),
  ];
  // A note made by an earlier attempt (a crash before the event was recorded) stays as it is.
  for (const entry of records) await deps.credits.insert(market, entry);
  return ok({ kind: 'credits', credits: records, mode });
}

/**
 * `qualify-referral-on-delivery`, for `ordering.seller-order-delivered.v1`: when the delivered
 * seller order is a pending-referral customer's qualifying order, checks the abuse signals and
 * the promotion's limits and credits both the referrer and the new customer. Once per referral.
 */
export async function qualifyReferralOnDelivery(
  deps: PromotionsDependencies,
  context: CallContext,
  input: DeliveryInput,
): Promise<Result<CreditFlowOutput, CreditFlowFailure>> {
  const ids = idsOf(input);
  if (ids === null) return err({ code: 'validation.failed' });
  const { market } = context;

  // Credits reserved by an earlier attempt for the referral this seller order qualified are
  // finished first, whatever the switch and the programs say now.
  const earlier = await deps.unitOfWork.run(
    market,
    async () => {
      const qualified = await deps.referrals.findQualifiedBySellerOrder(market, ids.sellerOrderId);
      if (qualified === null) return ok([] as CreditRecord[]);
      return ok(
        (
          await Promise.all([
            deps.credits.findBySource(market, 'REFERRER_REWARD', qualified.id),
            deps.credits.findBySource(market, 'REFEREE_REWARD', qualified.id),
          ])
        ).flatMap((c) => (c === null ? [] : [c])),
      );
    },
    { readOnly: true },
  );
  if (!earlier.ok) return tryAgain();
  if (earlier.value.length > 0) {
    return finishReserved(deps, context, input.delivery, earlier.value);
  }

  const settings = await switchState(deps, context);
  if (settings === 'fault') return tryAgain();
  if (settings === 'off') return handled(deps, context, input.delivery, 'nothing');

  const live = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.promotions.listLiveOfTypes(market, deps.clock.now(), ['REFERRAL'])),
    { readOnly: true },
  );
  if (!live.ok) return tryAgain();
  if (live.value.length === 0) return handled(deps, context, input.delivery, 'nothing');

  const facts = await deps.orderFacts.read(context, ids);
  if (!facts.known) {
    logger.warn({
      msg: 'promotions.referral.facts-unknown',
      sellerOrderId: ids.sellerOrderId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return tryAgain();
  }
  const order = facts.value;
  if (
    order.sellerOrderId !== ids.sellerOrderId ||
    order.orderId !== ids.orderId ||
    order.goodsPaid.currency !== settings.currency
  ) {
    return handled(deps, context, input.delivery, 'nothing');
  }

  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const referral = await deps.referrals.findByReferee(market, order.customerAccountId);
      const credits =
        referral === null
          ? []
          : [
              await deps.credits.findBySource(market, 'REFERRER_REWARD', referral.id),
              await deps.credits.findBySource(market, 'REFEREE_REWARD', referral.id),
            ].flatMap((c) => (c === null ? [] : [c]));
      return ok({ referral, credits });
    },
    { readOnly: true },
  );
  if (!read.ok) return tryAgain();
  const referral = read.value.referral;
  if (referral === null) return handled(deps, context, input.delivery, 'nothing');

  // Guard: the referral and its credits are written in one unit, so a QUALIFIED referral here is a
  // legacy or manually repaired row; carry on from the wallet calls rather than skip it.
  if (referral.status === 'QUALIFIED') {
    if (referral.qualifyingSellerOrderId !== order.sellerOrderId) {
      return handled(deps, context, input.delivery, 'nothing');
    }
    const settlements = await grantPending(deps, context, read.value.credits);
    if (settlements === null) return tryAgain();
    return settleAndHandle(deps, context, input.delivery, settlements, 'issued');
  }
  if (referral.status !== 'PENDING') return handled(deps, context, input.delivery, 'nothing');

  const now = deps.clock.now();
  if (now.epochMilliseconds >= referral.expiresAt.epochMilliseconds) {
    const marked = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      await deps.referrals.decide(market, referral.id, { status: 'EXPIRED' }, now);
      return ok(undefined);
    });
    if (!marked.ok) return tryAgain();
    return ok({ outcome: marked.value.handled ? 'expired' : 'already-handled' });
  }
  // The qualifying order is one placed after the code was applied, by the new customer.
  if (order.placedAt.epochMilliseconds < referral.createdAt.epochMilliseconds) {
    return handled(deps, context, input.delivery, 'nothing');
  }

  // The abuse check: only a clear answer lets the reward through; an unknown one waits for the
  // customer's next qualifying order (the referral stays pending until it expires).
  const verdict = await deps.referralSignals.compare(context, {
    referrerAccountId: referral.referrerAccountId,
    refereeAccountId: referral.refereeAccountId,
    orderId: order.orderId,
  });
  if (verdict === 'unknown') {
    logger.warn({
      msg: 'promotions.referral.signals-unknown',
      referralId: referral.id,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return handled(deps, context, input.delivery, 'pending');
  }
  if (verdict === 'same-household' || verdict === 'same-payment') {
    const reason: ReferralRejectReason =
      verdict === 'same-household' ? 'SAME_HOUSEHOLD' : 'SAME_PAYMENT';
    const marked = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      await deps.referrals.decide(market, referral.id, { status: 'REJECTED', reason }, now);
      return ok(undefined);
    });
    if (!marked.ok) return tryAgain();
    return ok({ outcome: marked.value.handled ? 'rejected' : 'already-handled' });
  }

  const decided = await deps.unitOfWork.run(market, () =>
    qualifyInUnit(deps, context, settings, referral, order),
  );
  if (!decided.ok) return decided;
  const result = decided.value;
  if (result.kind === 'nothing') return handled(deps, context, input.delivery, 'pending');
  if (result.kind === 'decided') return handled(deps, context, input.delivery, result.outcome);
  if (result.mode === 'RECORD') return handled(deps, context, input.delivery, 'recorded');
  const settlements = await grantPending(deps, context, result.credits);
  if (settlements === null) return tryAgain();
  return settleAndHandle(deps, context, input.delivery, settlements, 'issued');
}
