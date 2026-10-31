import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  blockReasonOfRefusal,
  type BlockReason,
  type Payout,
  type PayoutState,
} from '../domain/payout';
import { sellerVisibleHoldReason, type SellerVisibleHoldReason } from '../domain/payout-hold';
import { isKnownZone, latestSlot, nextSlotAfter } from '../domain/payout-schedule';
import { encodePayoutCursor, pageFields, pageOf, type MoneyView } from './payout-admin-flow';
import type { PayoutDependencies } from './payout-dependencies';
import { planSeller } from './payout-planning';
import { sellerIdOf } from './rate-flow';

// What a seller sees of its payouts (package 6d; design 5.4): the estimated next payout with a
// reason when it is not on its way, its history, and the money on hold. Own resources only: the
// seller is the acting seller's. No admin note, actor or internal code reaches a body.

export type SellerPayoutFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.terms-unavailable' }
  | { readonly code: 'commission-payouts.unavailable' };

const sellerOf = (context: CallContext): Id<'Seller'> | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'seller'
    ? sellerIdOf(actor.sellerId)
    : null;
};

const moneyOf = (amountMinor: bigint, currency: string): MoneyView => ({ amountMinor, currency });

// ---------------------------------------------------------------------------------------------
// The next payout

export interface NextPayoutView {
  /** When the next payout is looked at, in the seller's zone; null while the zone is missing. */
  readonly slotAt: Temporal.Instant | null;
  readonly zone: string | null;
  /** What would be transferred; null when nothing would. */
  readonly estimatedAmount: MoneyView | null;
  /** Why the payout is not on its way; null when nothing blocks it. */
  readonly blockReason: BlockReason | null;
}

/** The reasons a past evaluation may have left that are still true until the next one. */
const LASTING_REASONS: readonly BlockReason[] = [
  'account-not-ready',
  'cooling-off',
  'payouts-paused',
  'second-factor-required',
];

/** The signed-in seller's estimated next payout. An estimate, not a promise. */
export async function viewNextPayout(
  deps: PayoutDependencies,
  context: CallContext,
): Promise<Result<NextPayoutView, SellerPayoutFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const market = context.market;
  const settings = deps.policy.settings(market);
  if (settings === null) return err({ code: 'commission-payouts.terms-unavailable' });
  const now = deps.clock.now();

  const zones = await deps.access.zones(context, [sellerId]);
  if (zones === 'unavailable') return err({ code: 'commission-payouts.unavailable' });
  const found = zones.get(sellerId);
  const zone =
    found === undefined || found.provisional || !isKnownZone(found.zone) ? null : found.zone;

  return deps.unitOfWork.run<NextPayoutView, SellerPayoutFailure>(
    market,
    async () => {
      const terms = await deps.terms.resolve(market, sellerId);
      if (!terms.ok) return err({ code: 'commission-payouts.terms-unavailable' } as const);
      const [live, cursor] = [
        await deps.payouts.findLive(market, sellerId),
        await deps.cursors.find(market, sellerId),
      ];
      if (zone === null) {
        return ok({ slotAt: null, zone: null, estimatedAmount: null, blockReason: 'zone-missing' });
      }
      const schedule = {
        weekdays: terms.value.terms.weekdays,
        localTime: terms.value.terms.localTime,
      };
      const due = cursor === null ? null : latestSlot(schedule, zone, cursor.lastSlotAt, now);
      const slotAt =
        due !== null ? (cursor?.nextSlotAt ?? now) : nextSlotAfter(schedule, zone, now);
      if (live !== null) {
        return ok({
          slotAt,
          zone,
          estimatedAmount: live.transfer > 0n ? moneyOf(live.transfer, live.currency) : null,
          blockReason: live.state === 'awaiting-approval' ? 'awaiting-approval' : null,
        });
      }
      const plan = await planSeller(
        deps,
        market,
        sellerId,
        settings.currency,
        terms.value.terms.minimumMinor,
        Temporal.Instant.compare(slotAt, now) > 0 ? slotAt : now,
      );
      const stored = cursor?.blockReason ?? null;
      const blockReason: BlockReason | null = plan.plan.sellerHeld
        ? 'payouts-paused'
        : plan.plan.transfer > 0n && plan.plan.belowMinimum
          ? 'below-minimum'
          : stored !== null && LASTING_REASONS.includes(stored)
            ? stored
            : null;
      return ok({
        slotAt,
        zone,
        estimatedAmount:
          plan.plan.transfer > 0n ? moneyOf(plan.plan.transfer, settings.currency) : null,
        blockReason,
      });
    },
    { readOnly: true },
  );
}

// ---------------------------------------------------------------------------------------------
// History

export type SellerPayoutState =
  'scheduled' | 'awaiting-approval' | 'on-its-way' | 'paid' | 'not-sent' | 'failed' | 'settled';

export interface OwnPayoutView {
  readonly payoutId: Id<'Payout'>;
  readonly status: SellerPayoutState;
  readonly gross: MoneyView;
  readonly netted: MoneyView;
  readonly transfer: MoneyView;
  readonly slotAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  /** For a payout that did not arrive: what the seller can act on, else a pause. */
  readonly reason: BlockReason | null;
}

export interface OwnPayoutsView {
  readonly payouts: readonly OwnPayoutView[];
  readonly nextCursor: string | null;
}

const SELLER_STATUS: Readonly<Record<PayoutState, SellerPayoutState | null>> = {
  pending: 'scheduled',
  'awaiting-approval': 'awaiting-approval',
  approved: 'scheduled',
  instructing: 'on-its-way',
  instructed: 'on-its-way',
  paid: 'paid',
  failed: 'failed',
  'not-sent': 'not-sent',
  // A voided payout never happened: the seller does not see it.
  voided: null,
  'settled-by-netting': 'settled',
};

const ownView = (payout: Payout): OwnPayoutView => ({
  payoutId: payout.id,
  status: SELLER_STATUS[payout.state] ?? 'scheduled',
  gross: moneyOf(payout.gross, payout.currency),
  netted: moneyOf(payout.netted, payout.currency),
  transfer: moneyOf(payout.transfer, payout.currency),
  slotAt: payout.slotAt,
  createdAt: payout.createdAt,
  updatedAt: payout.stateChangedAt,
  reason:
    payout.state === 'not-sent' && payout.outcomeCode !== null
      ? blockReasonOfRefusal(payout.outcomeCode)
      : null,
});

/** The signed-in seller's payouts, newest first; voided ones are hidden. */
export async function listOwnPayouts(
  deps: PayoutDependencies,
  context: CallContext,
  input: { readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<OwnPayoutsView, SellerPayoutFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const page = pageOf(input);
  if (!page.ok) {
    return err({ code: 'validation.failed', fields: pageFields(page.error) });
  }
  return deps.unitOfWork.run<OwnPayoutsView, SellerPayoutFailure>(
    context.market,
    async () => {
      const rows = await deps.payouts.listForSeller(context.market, sellerId, ['voided'], {
        ...page.value,
        limit: page.value.limit + 1,
      });
      const shown = rows.slice(0, page.value.limit);
      const last = shown[shown.length - 1];
      return ok({
        payouts: shown.map(ownView),
        nextCursor:
          rows.length > page.value.limit && last !== undefined
            ? encodePayoutCursor(last.createdAt, last.id)
            : null,
      });
    },
    { readOnly: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Money on hold

export type HeldReason = SellerVisibleHoldReason | 'holding-period' | 'awaiting-delivery';

export interface OwnHeldView {
  /** The seller order whose money waits; null for a hold on the whole seller. */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  readonly amount: MoneyView | null;
  readonly reason: HeldReason;
  /** When the money becomes available for a payout, if that is known. */
  readonly availableFrom: Temporal.Instant | null;
}

const HELD_LIMIT = 200;

/**
 * The signed-in seller's money that is not yet payable, per seller order: held (a refund pending,
 * or generically on hold), waiting for the holding period, or waiting for the delivery. No admin
 * note, hold id, actor or exact internal reason.
 */
export async function listOwnPayoutHolds(
  deps: PayoutDependencies,
  context: CallContext,
): Promise<Result<readonly OwnHeldView[], SellerPayoutFailure>> {
  const sellerId = sellerOf(context);
  if (sellerId === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.terms-unavailable' });
  const now = deps.clock.now();
  const market = context.market;
  return deps.unitOfWork.run<readonly OwnHeldView[], SellerPayoutFailure>(
    market,
    async () => {
      const nets = await deps.ledger.netBySellerOrder(market, sellerId, settings.currency);
      const position = await deps.payouts.position(market, sellerId);
      const holds = await deps.holds.listForSeller(market, sellerId, {
        activeOnly: true,
        limit: 1000,
      });
      const open = nets.filter(
        ({ sellerOrderId, net }) => net > 0n && !position.itemAmounts.has(sellerOrderId),
      );
      const anchors = await deps.anchors.findMany(
        market,
        open.map((row) => row.sellerOrderId),
      );
      const eligibleAt = new Map(
        anchors.map((anchor) => [anchor.sellerOrderId, anchor.eligibleAt]),
      );
      const wholeSeller = holds.find((hold) => hold.sellerOrderId === null);
      const out: OwnHeldView[] = [];
      for (const { sellerOrderId, net } of open) {
        const own = holds.find((hold) => hold.sellerOrderId === sellerOrderId) ?? wholeSeller;
        const eligible = eligibleAt.get(sellerOrderId);
        const amount = moneyOf(net, settings.currency);
        if (own !== undefined) {
          out.push({
            sellerOrderId,
            amount,
            reason: sellerVisibleHoldReason(own.reason),
            availableFrom: null,
          });
        } else if (eligible === undefined) {
          out.push({ sellerOrderId, amount, reason: 'awaiting-delivery', availableFrom: null });
        } else if (Temporal.Instant.compare(eligible, now) > 0) {
          out.push({ sellerOrderId, amount, reason: 'holding-period', availableFrom: eligible });
        }
      }
      // A hold on a seller order that has no open money (or on the whole seller with none) still
      // tells the seller something is held.
      if (wholeSeller !== undefined && out.length === 0) {
        out.push({
          sellerOrderId: null,
          amount: null,
          reason: sellerVisibleHoldReason(wholeSeller.reason),
          availableFrom: null,
        });
      }
      out.sort(
        (a, b) =>
          (a.availableFrom?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER) -
          (b.availableFrom?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER),
      );
      return ok(out.slice(0, HELD_LIMIT));
    },
    { readOnly: true },
  );
}
