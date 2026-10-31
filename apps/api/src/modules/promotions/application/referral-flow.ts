import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { ReferralRecord } from '../domain/credit';
import type { PromotionRecord } from '../domain/promotion';
import type { PromotionsFailure } from './failures';
import { activeSettings } from './market-switch';
import type { PromotionsDependencies } from './promotions-dependencies';

// The customer's side of refer a friend (promotions phase 3): a customer reads their own referral
// code, and a new customer applies someone else's. The code is derived from the pepper and the
// account (never stored; only its hash is) and shown again whenever the customer asks. Both
// routes are the customer's own: the account is the session's, never an input.

interface Customer {
  readonly accountId: Id<'Account'>;
}

function customerOf(context: CallContext): Customer | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') return null;
  return { accountId: actor.accountId };
}

const subjectOf = (context: CallContext, accountId: Id<'Account'>): string =>
  `${context.market.marketId}|${accountId}`;

/** The live program a new referral is bound to: the first live REFERRAL promotion by id. */
function programOf(
  live: readonly PromotionRecord[],
  currency: string,
):
  | (PromotionRecord & { readonly reward: { readonly kind: 'FIXED'; readonly amount: bigint } })
  | null {
  for (const promotion of live) {
    if (
      promotion.type === 'REFERRAL' &&
      promotion.currency === currency &&
      promotion.reward.kind === 'FIXED' &&
      promotion.refereeRewardMinor !== null
    ) {
      return promotion as never;
    }
  }
  return null;
}

export interface MyReferralView {
  readonly code: string;
  /** What the program pays, minor units of `currency`. */
  readonly referrerRewardMinor: bigint;
  readonly refereeRewardMinor: bigint;
  readonly currency: string;
  /** The most rewarded referrals the program allows one referrer. */
  readonly maxRewarded: number;
  readonly pending: number;
  readonly qualified: number;
}

/** The customer's own referral code with the program's terms and their counts. Created on first ask. */
export async function viewMyReferral(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<MyReferralView, PromotionsFailure>> {
  const customer = customerOf(context);
  if (customer === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const rules = switched.value.rules.referral ?? null;
  if (rules === null) return err({ code: 'promotions.not-found' });
  if (!deps.codeCrypto.available) return err({ code: 'promotions.unavailable' });
  const now = deps.clock.now();
  const code = deps.codeCrypto.referralCode(
    subjectOf(context, customer.accountId),
    rules.alphabet,
    rules.codeLength,
  );
  const hash = deps.codeCrypto.referralHash(code);

  return deps.unitOfWork.run<MyReferralView, PromotionsFailure>(context.market, async () => {
    const program = programOf(
      await deps.promotions.listLiveOfTypes(context.market, now, ['REFERRAL']),
      switched.value.currency,
    );
    if (program === null) return err({ code: 'promotions.not-found' });
    const stored = await deps.referrals.findCode(context.market, customer.accountId);
    if (stored === null) {
      const inserted = await deps.referrals.insertCode(context.market, {
        accountId: customer.accountId,
        codeHash: hash,
        createdAt: now,
      });
      // The hash is taken by someone else: not expected for a 60-bit code; fail closed.
      if (inserted === 'duplicate') {
        const again = await deps.referrals.findCode(context.market, customer.accountId);
        if (again === null || again.codeHash !== hash)
          return err({ code: 'promotions.unavailable' });
      }
    } else if (stored.codeHash !== hash) {
      // The pepper changed since the code was stored: the code on file cannot be shown.
      return err({ code: 'promotions.unavailable' });
    }
    const mine = (status: ReferralRecord['status']) =>
      deps.referrals.countByReferrer(context.market, customer.accountId, program.id, status);
    return ok({
      code,
      referrerRewardMinor: program.reward.amount,
      refereeRewardMinor: program.refereeRewardMinor!,
      currency: program.currency,
      maxRewarded: program.maxUsesPerCustomer ?? rules.maxRewardedPerReferrer,
      pending: await mine('PENDING'),
      qualified: await mine('QUALIFIED'),
    });
  });
}

export interface AppliedReferral {
  readonly status: 'PENDING';
  /** The instant by which the new customer's qualifying order must be delivered. */
  readonly expiresAt: Temporal.Instant;
}

/**
 * A new customer applies a referrer's code. It is refused (one answer, `referral-not-eligible`)
 * for the customer's own code, for a customer who has ordered before or whose history cannot be
 * read, and for a customer referred already; an unknown or malformed code, and a Market with no
 * live program, are `not-found`, so a refusal does not say which codes exist.
 */
export async function applyReferralCode(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly code?: unknown },
): Promise<Result<AppliedReferral, PromotionsFailure>> {
  const customer = customerOf(context);
  if (customer === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const rules = switched.value.rules.referral ?? null;
  if (rules === null) return err({ code: 'promotions.not-found' });
  if (!deps.codeCrypto.available) return err({ code: 'promotions.unavailable' });

  const typed = typeof input?.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (typed.length === 0 || typed.length > 64) {
    return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'value' }] });
  }
  // A text that cannot be one of the Market's codes finds nothing, without a lookup.
  if (typed.length !== rules.codeLength || [...typed].some((ch) => !rules.alphabet.includes(ch))) {
    return err({ code: 'promotions.not-found' });
  }
  const hash = deps.codeCrypto.referralHash(typed);

  // The new customer has never ordered: asked of the owner before any unit opens.
  const history = await deps.orderHistory.lastOrderAt(context, customer.accountId);
  if (!history.known || history.value !== null) {
    return err({ code: 'promotions.referral-not-eligible' });
  }

  const now = deps.clock.now();
  return deps.unitOfWork.run<AppliedReferral, PromotionsFailure>(context.market, async () => {
    const program = programOf(
      await deps.promotions.listLiveOfTypes(context.market, now, ['REFERRAL']),
      switched.value.currency,
    );
    if (program === null) return err({ code: 'promotions.not-found' });
    const owner = await deps.referrals.findCodeByHash(context.market, hash);
    if (owner === null) return err({ code: 'promotions.not-found' });
    if (owner.accountId === customer.accountId) {
      return err({ code: 'promotions.referral-not-eligible' });
    }
    if ((await deps.referrals.findByReferee(context.market, customer.accountId)) !== null) {
      return err({ code: 'promotions.referral-not-eligible' });
    }
    const expiresAt = now.add({ hours: rules.qualifyWithinDays * 24 });
    const record: ReferralRecord = {
      id: deps.ids.next<'Referral'>(),
      promotionId: program.id,
      referrerAccountId: owner.accountId,
      refereeAccountId: customer.accountId,
      status: 'PENDING',
      rejectReason: null,
      createdAt: now,
      expiresAt,
      decidedAt: null,
      qualifyingOrderId: null,
      qualifyingSellerOrderId: null,
    };
    if ((await deps.referrals.insert(context.market, record)) === 'duplicate') {
      return err({ code: 'promotions.referral-not-eligible' });
    }
    return ok({ status: 'PENDING', expiresAt });
  });
}
