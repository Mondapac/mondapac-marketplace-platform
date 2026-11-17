import { Logger } from '@nestjs/common';
import { money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { shareOf, type ClawbackRecord, type CreditRecord } from '../domain/credit';
import {
  handled,
  sellerFunderOf,
  tryAgain,
  type CreditFlowFailure,
  type CreditFlowOutput,
} from './credit-flow';
import type { PromotionsDependencies } from './promotions-dependencies';

// A refund after a cashback was credited (customers phase 4c-2). A cashback is what the goods the
// customer paid for and kept earn; when a refund gives goods back after the credit reached the
// wallet, the part they no longer earn is taken back from what is left of the credit's wallet lot
// (credit the customer already spent stays spent), and for a seller's own cashback the seller gets
// back what was taken. A refund inside the payout hold changes nothing here: the grant job nets it
// before the credit is paid.
//
// The order of work, for each `ordering.refund-succeeded.v1`:
//   1. read-only: the seller order's cashback and its clawbacks; a clawback already made for this
//      refund is finished (step 4) and nothing else;
//   2. outside a unit: the seller order's facts (goods kept, net of every refund so far) and the
//      promotion; what is to be taken back in all, less what earlier refunds asked for;
//   3. one unit: the clawback row (PENDING) at the next `seq`; a clash (another refund of the same
//      credit counted from the same total) retries the delivery, which counts again;
//   4. outside a unit: the wallet (key from the clawback), then the seller ledger for what it took;
//   5. `runOnce`: the clawback DONE with what was taken, and the event recorded as handled.
// A crash repeats the delivery: step 1 finds the PENDING row and carries on from step 4; the
// wallet and the ledger answer a repeat with their first result.

const logger = new Logger('PromotionsClawbacks');

export interface RefundInput {
  readonly delivery: EventDelivery;
  readonly orderId: unknown;
  readonly sellerOrderId: unknown;
  readonly refundId: unknown;
}

export type ClawbackOutcome = CreditFlowOutput['outcome'];

function idsOf(input: RefundInput) {
  const parse = <K extends string>(value: unknown) => {
    const parsed = typeof value === 'string' ? parseId<K>(value) : null;
    return parsed !== null && parsed.ok ? parsed.value : null;
  };
  const orderId = parse<'Order'>(input?.orderId);
  const sellerOrderId = parse<'SellerOrder'>(input?.sellerOrderId);
  const refundId = parse<'Refund'>(input?.refundId);
  if (orderId === null || sellerOrderId === null || refundId === null) return null;
  return { orderId, sellerOrderId, refundId };
}

/** The wallet key of a clawback: one per row, so a repeat answers the first result. */
export const clawbackKey = (clawbackId: string): string => `promotions:clawback:${clawbackId}`;

/**
 * `claw-back-on-refund`, for `ordering.refund-succeeded.v1`: takes back from the customer's wallet
 * the part of a credited cashback that the goods given back no longer earn. Once per refund.
 */
export async function clawBackOnRefund(
  deps: PromotionsDependencies,
  context: CallContext,
  input: RefundInput,
): Promise<Result<{ readonly outcome: ClawbackOutcome }, CreditFlowFailure>> {
  const ids = idsOf(input);
  if (ids === null) return { ok: false, error: { code: 'validation.failed' } };
  const { market } = context;
  const nothing = () => handled(deps, context, input.delivery, 'nothing');

  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const credit = await deps.credits.findBySource(market, 'CASHBACK', ids.sellerOrderId);
      const clawbacks = credit === null ? [] : await deps.credits.listClawbacks(market, credit.id);
      return ok({ credit, clawbacks });
    },
    { readOnly: true },
  );
  if (!read.ok) return tryAgain();
  const { credit, clawbacks } = read.value;
  if (credit === null || credit.orderId !== ids.orderId) return nothing();
  if (credit.status === 'PENDING') {
    // Still waiting for the payout release: the grant job reads the refund then. A credit whose
    // wait has ended is being paid now: wait until it is, then take back (Hassan L-5).
    const now = deps.clock.now();
    if (credit.grantAfter !== null && credit.grantAfter.epochMilliseconds > now.epochMilliseconds) {
      return nothing();
    }
    logger.warn({
      msg: 'promotions.clawback.credit-pending',
      creditId: credit.id,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return tryAgain();
  }
  // A test-mode note moved no money; a failed credit paid nothing.
  if (credit.status !== 'GRANTED' || credit.walletJournalId === null) return nothing();

  const mine = clawbacks.find((clawback) => clawback.refundId === ids.refundId);
  if (mine !== undefined) {
    if (mine.status === 'DONE') return handled(deps, context, input.delivery, 'clawed-back');
    return finish(deps, context, input.delivery, credit, mine);
  }

  const facts = await deps.orderFacts.read(context, {
    orderId: ids.orderId,
    sellerOrderId: ids.sellerOrderId,
  });
  if (!facts.known) return tryAgain();
  if (facts.value.goodsPaid.currency !== credit.currency) return nothing();
  const promotion = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.promotions.find(market, credit.promotionId)),
    { readOnly: true },
  );
  if (!promotion.ok || promotion.value === null) return tryAgain();
  // What the goods kept earn now, at the promotion's percent within the Market's limit; never more
  // than was credited (the cap and the budget were applied then).
  const reward = promotion.value.reward;
  const limits = deps.policy.settings(market)?.rules.cashback ?? null;
  const goods = facts.value.goodsPaid.amount;
  let kept = credit.amountMinor;
  if (reward.kind === 'PERCENT') {
    const earned = shareOf(
      goods,
      limits === null ? reward.bps : Math.min(reward.bps, limits.maxBps),
    );
    if (earned < kept) kept = earned;
  } else if (goods <= 0n) {
    kept = 0n;
  }
  const asked = clawbacks.reduce((sum, clawback) => sum + clawback.amountMinor, 0n);
  const share = credit.amountMinor - kept - asked;
  if (share <= 0n) return nothing();

  const row: ClawbackRecord = {
    id: deps.ids.next<'CreditClawback'>(),
    creditId: credit.id,
    refundId: ids.refundId,
    seq: (clawbacks.at(-1)?.seq ?? 0) + 1,
    amountMinor: share,
    currency: credit.currency,
    status: 'PENDING',
    clawedMinor: null,
    walletJournalId: null,
    createdAt: deps.clock.now(),
    settledAt: null,
  };
  const inserted = await deps.unitOfWork.run(market, async () =>
    ok(await deps.credits.insertClawback(market, row)),
  );
  // Another refund of this credit counted from the same total: count again on the retry.
  if (!inserted.ok || inserted.value !== 'inserted') return tryAgain();
  return finish(deps, context, input.delivery, credit, row);
}

/** Steps 4 and 5: the wallet, the seller ledger for what it took, then the row DONE. */
async function finish(
  deps: PromotionsDependencies,
  context: CallContext,
  delivery: EventDelivery,
  credit: CreditRecord,
  row: ClawbackRecord,
): Promise<Result<{ readonly outcome: ClawbackOutcome }, CreditFlowFailure>> {
  const { market } = context;
  const funder = await sellerFunderOf(deps, context, credit);
  if (funder === 'fault') return tryAgain();
  const taken = await deps.walletCredit.clawBack(context, {
    accountId: credit.recipientAccountId,
    grantJournalId: credit.walletJournalId!,
    amount: money(row.amountMinor, row.currency),
    orderId: credit.orderId,
    idempotencyKey: clawbackKey(row.id),
  });
  let clawed = 0n;
  let journalId: string | null = null;
  if (taken.ok) {
    clawed = taken.value.clawedBack;
    journalId = taken.value.journalId;
  } else if (taken.error.retry) {
    logger.warn({
      msg: 'promotions.clawback.wallet-retry',
      clawbackId: row.id,
      code: taken.error.code,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return tryAgain();
  } else {
    // The grant cannot be found for this customer: nothing is taken, and an operator looks.
    logger.error({
      msg: 'promotions.clawback.wallet-refused',
      clawbackId: row.id,
      code: taken.error.code,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
  }
  if (clawed > 0n && funder !== null) {
    const returned = await deps.sellerCashbackLedger.recordReturn(context, {
      clawbackId: row.id,
      creditId: credit.id,
      orderId: credit.orderId!,
      sellerOrderId: credit.sourceId as Id<'SellerOrder'>,
      sellerId: funder,
      amount: clawed,
      currency: row.currency,
      returnedAt: deps.clock.now(),
    });
    if (!returned) {
      logger.warn({
        msg: 'promotions.clawback.seller-ledger-retry',
        clawbackId: row.id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return tryAgain();
    }
  }
  const now = deps.clock.now();
  const done = await deps.unitOfWork.runOnce(market, delivery, async () => {
    await deps.credits.settleClawback(
      market,
      row.id,
      { clawedMinor: clawed, walletJournalId: clawed > 0n ? journalId : null },
      now,
    );
    return ok(undefined);
  });
  if (!done.ok) return tryAgain();
  return ok({ outcome: done.value.handled ? 'clawed-back' : 'already-handled' });
}
