import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { isExpired } from '../domain/lots';
import { refusalFor } from '../domain/wallet-status';
import { actorOf, releaseInUnit, type WalletFailure } from './wallet-flow';
import type { WalletDependencies } from './wallet-dependencies';

// The worker's two sweeps (customer wallet package 1): holds past their expiry are released, and
// promo lots past their expiry move to breakage income. Both run in every wallet state except
// `off`, and neither deletes or zeroes anything else: expiry is a journal, like every change.
// Each item has its own unit, so one failure does not stop the others.

export interface ExpiryReport {
  readonly expiredHolds: number;
  readonly expiredLots: number;
  /** Ids of items whose unit failed; they are tried again on the next run. */
  readonly failed: readonly string[];
}

export const EXPIRY_BATCH = 100;

export async function expireDue(
  deps: WalletDependencies,
  context: CallContext,
): Promise<Result<ExpiryReport, WalletFailure>> {
  const policy = deps.policy.settings(context.market);
  if (policy === null) return err({ code: 'wallet.unavailable' });
  const now = deps.clock.now();
  const probe = await deps.unitOfWork.run<
    {
      readonly on: boolean;
      readonly holds: readonly Id<'WalletHold'>[];
      readonly lots: readonly Id<'WalletLot'>[];
    },
    WalletFailure
  >(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market);
      if (refusalFor(setting?.status ?? 'off', 'expire') !== null) {
        return ok({ on: false, holds: [], lots: [] });
      }
      return ok({
        on: true,
        holds: (await deps.wallet.dueHolds(context.market, now, EXPIRY_BATCH)).map((h) => h.holdId),
        lots: (await deps.wallet.dueLots(context.market, now, EXPIRY_BATCH)).map((l) => l.lotId),
      });
    },
    { readOnly: true },
  );
  if (!probe.ok) return probe;
  const failed: string[] = [];
  let expiredHolds = 0;
  let expiredLots = 0;

  for (const holdId of probe.value.holds) {
    try {
      const done = await expireHold(deps, context, holdId);
      if (done) expiredHolds += 1;
    } catch {
      failed.push(holdId);
    }
  }
  for (const lotId of probe.value.lots) {
    try {
      const done = await expireLot(deps, context, lotId);
      if (done) expiredLots += 1;
    } catch {
      failed.push(lotId);
    }
  }
  return ok({ expiredHolds, expiredLots, failed });
}

async function expireHold(
  deps: WalletDependencies,
  context: CallContext,
  holdId: Id<'WalletHold'>,
): Promise<boolean> {
  const policy = deps.policy.settings(context.market)!;
  const now = deps.clock.now();
  const result = await deps.unitOfWork.run<boolean, WalletFailure>(context.market, async () => {
    const seen = await deps.wallet.findHoldById(context.market, holdId);
    if (seen === null) return ok(false);
    const balance = await deps.wallet.lockBalance(context.market, seen.walletAccountId);
    // Read again under the lock: a release or capture may have won.
    const hold = await deps.wallet.findHoldById(context.market, holdId);
    if (hold === null || hold.status !== 'held') return ok(false);
    if (hold.expiresAt.epochMilliseconds > now.epochMilliseconds) return ok(false);
    await releaseInUnit(deps, context, {
      hold,
      balance,
      status: 'expired',
      idempotencyKey: `hold-expire:${holdId}`,
      fingerprint: `hold-expire|${holdId}`,
      reasonCode: 'hold-expired',
      currency: policy.currency,
      now,
    });
    return ok(true);
  });
  return result.ok && result.value;
}

async function expireLot(
  deps: WalletDependencies,
  context: CallContext,
  lotId: Id<'WalletLot'>,
): Promise<boolean> {
  const policy = deps.policy.settings(context.market)!;
  const now = deps.clock.now();
  const result = await deps.unitOfWork.run<boolean, WalletFailure>(context.market, async () => {
    const seen = await deps.wallet.findLotWallet(context.market, lotId);
    if (seen === null) return ok(false);
    const balance = await deps.wallet.lockBalance(context.market, seen);
    const lot = await deps.wallet.findLot(context.market, lotId);
    if (lot === null || lot.source !== 'promo' || lot.remaining === 0n || !isExpired(lot, now)) {
      return ok(false);
    }
    const accounts = await deps.wallet.ensureInternalAccounts(context.market, ['breakage_income'], {
      newId: () => deps.ids.next<'WalletAccount'>(),
      currency: policy.currency,
      now,
    });
    const journalId = deps.ids.next<'WalletJournal'>();
    await deps.wallet.appendJournal(context.market, {
      id: journalId,
      kind: 'expire',
      // The lock above serialises sweeps of this wallet, and `remaining` is re-read, so a lot is
      // never expired twice for the same credit; a restored remainder gets a new key.
      idempotencyKey: `expire:${lotId}:${journalId}`,
      fingerprint: `expire|${lotId}|${lot.remaining}`,
      actor: actorOf(context),
      reasonCode: 'promo-expired',
      orderId: null,
      walletAccountId: seen,
      currency: policy.currency,
      createdAt: now,
      result: { journalId, lotId, amountMinor: lot.remaining.toString() },
      postings: [
        { accountId: seen, amountMinor: -lot.remaining },
        { accountId: accounts.get('breakage_income')!, amountMinor: lot.remaining },
      ],
    });
    await deps.wallet.setLotRemaining(context.market, lotId, 0n);
    await deps.wallet.saveBalance(
      context.market,
      { ...balance, availableMinor: balance.availableMinor - lot.remaining },
      now,
    );
    return ok(true);
  });
  return result.ok && result.value;
}
