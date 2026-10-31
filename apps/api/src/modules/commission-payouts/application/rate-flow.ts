import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CommissionRate, CommissionRateMap } from '../contracts/commission-payouts.facade';
import { CommissionRateCleared, CommissionRateSet } from '../domain/audit';
import { parseRateBps } from '../domain/commission';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import { spendStepUp, type StepUpFailure } from './step-up';
import { COMMISSION_PAYOUTS_RATE_EDIT } from '../contracts/permissions';

// Commission rates (COM-01, COM-02): the Market rate comes from Market config; an admin may set a
// separate rate for one seller, or remove it to put the seller back on the Market rate. Each
// change is audited with the old value and applies to orders placed after it (ordering freezes
// the rate on each order line at checkout).

export type RateFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'commission-payouts.seller-not-found' }
  /** Removing a seller rate that does not exist. */
  | { readonly code: 'commission-payouts.rate-not-set' }
  | { readonly code: 'commission-payouts.rate-unavailable' }
  | { readonly code: 'commission-payouts.unavailable' }
  | StepUpFailure;

/** What the system read of several rates can refuse. */
export type RatesFailure = Extract<
  RateFailure,
  { code: 'access.denied' | 'validation.failed' | 'commission-payouts.rate-unavailable' }
>;

export interface RateView extends CommissionRate {
  readonly sellerId: Id<'Seller'>;
  /** The Market rate, so a screen can show what the seller would be on without its own rate. */
  readonly marketRateBps: number;
}

const MAX_IDS = 100;

export const sellerIdOf = (value: unknown): Id<'Seller'> | null => {
  const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const isAdmin = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

const invalidSeller = (): RateFailure => ({
  code: 'validation.failed',
  fields: [{ path: 'sellerId', code: 'format' }],
});

/** An admin reads one seller's rate in force and the Market rate. */
export async function viewCommissionRate(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<RateView, RateFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return err(invalidSeller());
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  return deps.unitOfWork.run<RateView, RateFailure>(
    context.market,
    async () => {
      const own = await deps.rates.find(context.market, sellerId);
      return ok({
        sellerId,
        rateBps: own?.rateBps ?? settings.defaultRateBps,
        source: own === null ? 'market' : 'seller',
        marketRateBps: settings.defaultRateBps,
      });
    },
    { readOnly: true },
  );
}

/** An admin sets a separate rate for an existing seller of the Market. */
export async function setCommissionRate(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown; readonly rateBps: unknown },
): Promise<Result<RateView, RateFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const fields: { path: string; code: string }[] = [];
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) fields.push({ path: 'sellerId', code: 'format' });
  const rate = parseRateBps(input?.rateBps);
  if (!rate.ok) fields.push({ path: rate.error.path, code: 'range' });
  if (sellerId === null || !rate.ok) return err({ code: 'validation.failed', fields });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });

  const known = await deps.sellers.exists(context, sellerId);
  if (known === 'unavailable') return err({ code: 'commission-payouts.unavailable' });
  if (!known) return err({ code: 'commission-payouts.seller-not-found' });

  const now = deps.clock.now();
  return deps.unitOfWork.run<RateView, RateFailure>(context.market, async () => {
    const before = await deps.rates.findForUpdate(context.market, sellerId);
    const spent = await spendStepUp(deps, context, COMMISSION_PAYOUTS_RATE_EDIT.key);
    if (!spent.ok) return err(spent.error);
    await deps.rates.save(context.market, {
      sellerId,
      rateBps: rate.value,
      updatedAt: now,
      updatedBy: actor.accountId,
    });
    await deps.audit.record(
      context,
      CommissionRateSet.entry(sellerId, {
        before: { rateBps: before?.rateBps ?? null },
        after: {
          rateBps: rate.value,
          marketRateBps: settings.defaultRateBps,
          belowMarketRate: rate.value < settings.defaultRateBps,
        },
      }),
    );
    return ok({
      sellerId,
      rateBps: rate.value,
      source: 'seller',
      marketRateBps: settings.defaultRateBps,
    });
  });
}

/** An admin removes a seller's own rate: the seller is back on the Market rate. */
export async function clearCommissionRate(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerId: unknown },
): Promise<Result<RateView, RateFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return err(invalidSeller());
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  return deps.unitOfWork.run<RateView, RateFailure>(context.market, async () => {
    const before = await deps.rates.findForUpdate(context.market, sellerId);
    if (before === null || !(await deps.rates.remove(context.market, sellerId))) {
      return err({ code: 'commission-payouts.rate-not-set' } as const);
    }
    const spent = await spendStepUp(deps, context, COMMISSION_PAYOUTS_RATE_EDIT.key);
    if (!spent.ok) return err(spent.error);
    await deps.audit.record(
      context,
      CommissionRateCleared.entry(sellerId, {
        before: { rateBps: before.rateBps },
        after: { marketRateBps: settings.defaultRateBps },
      }),
    );
    return ok({
      sellerId,
      rateBps: settings.defaultRateBps,
      source: 'market',
      marketRateBps: settings.defaultRateBps,
    });
  });
}

/** The system read behind the facade: the rate in force for up to 100 distinct sellers. */
export async function readCommissionRates(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
  input: { readonly sellerIds: unknown },
): Promise<Result<CommissionRateMap, RatesFailure>> {
  // Only checkout calls this, as the signed-in customer; every other actor is refused.
  const caller = context.actor;
  if (caller.kind !== 'authenticated' || caller.population !== 'customer') {
    return err({ code: 'access.denied' });
  }
  const raw = input?.sellerIds;
  if (!Array.isArray(raw) || raw.length > MAX_IDS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
  }
  const ids: Id<'Seller'>[] = [];
  for (const value of raw) {
    const id = sellerIdOf(value);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  return deps.unitOfWork.run<CommissionRateMap, RatesFailure>(
    context.market,
    async () => {
      const own = ids.length === 0 ? [] : await deps.rates.findMany(context.market, ids);
      const bySeller = new Map(own.map((row) => [row.sellerId, row.rateBps]));
      return ok(
        new Map(
          ids.map((id): [Id<'Seller'>, CommissionRate] => {
            const rateBps = bySeller.get(id);
            return [
              id,
              rateBps === undefined
                ? { rateBps: settings.defaultRateBps, source: 'market' }
                : { rateBps, source: 'seller' },
            ];
          }),
        ),
      );
    },
    { readOnly: true },
  );
}
