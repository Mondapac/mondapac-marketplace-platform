import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  impactItem,
  type ChangeImpact,
  type RevertOutcome,
  type RevertRequest,
  type SystemChangeReverter,
} from '../../system-requests';
import { CommissionRateReverted, PayoutTermsReverted } from '../domain/audit';
import { isRateBps } from '../domain/commission';
import { parsePayoutTermsOverride, type PayoutTermsOverride } from '../domain/payout-terms';
import type { SellerNames } from './ports/seller-names';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import { termsValues } from './money-review';
import type { PayoutTermsOverrideRecord } from './ports/payout-terms.repository';
import { sellerIdOf } from './rate-flow';
import { isActingAs } from './step-up';
import { announceTermsChange, termsAuditValues } from './terms-flow';

// The reverters of area money (see money-review.ts): each restores the value before a rejected or
// withdrawn change, only while the subject still holds the value after.

const adminOf = (context: CallContext): Id<'Account'> => {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin' || isActingAs(context)) {
    throw new Error('commission-payouts: a revert needs a signed-in admin acting as themselves');
  }
  return actor.accountId;
};

/**
 * The queue's labels of sellers (the subject of both money kinds): each seller's public store
 * name, read through sellers' facade (`SellerNames`). An unknown seller, a nameless one and a
 * failed read give no label.
 */
async function storeLabels(
  names: SellerNames | null,
  context: CallContext,
  subjectRefs: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  if (names === null) return labels;
  const ids = [...new Set(subjectRefs.map(sellerIdOf).filter((id) => id !== null))];
  if (ids.length === 0) return labels;
  const found = await names.storeNames(context, ids);
  if (found === 'unavailable') return labels;
  for (const ref of subjectRefs) {
    const sellerId = sellerIdOf(ref);
    const name = sellerId === null ? null : found.get(sellerId);
    if (typeof name === 'string' && name.trim() !== '') labels.set(ref, name);
  }
  return labels;
}

/**
 * The impact of a seller's own rate or payout terms (the request's detail page): that one seller.
 * No read: the subject is the seller, so the count is known; a ref that is not a seller id gives
 * none.
 */
export function oneSellerImpact(subjectRef: string): Promise<ChangeImpact | null> {
  return Promise.resolve(
    sellerIdOf(subjectRef) === null ? null : { items: [impactItem('sellers', 1)] },
  );
}

/** A stored rate value: null (the Market rate) or a rate an admin could set today. */
const rateOf = (value: unknown): number | null | undefined =>
  value === null || isRateBps(value) ? value : undefined;

/**
 * Restores a seller's own rate (or removes it when there was none before), in the open unit of
 * the decision, audited as a revert of the request. Applies to orders placed after it. (When the
 * seller had no row, nothing is locked: the same race two admins' first sets already have.)
 */
export class CommissionRateReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: CommissionPayoutsDependencies,
    private readonly names: SellerNames | null = null,
  ) {}

  /** The seller's store name. */
  describe(context: CallContext, subjectRefs: readonly string[]) {
    return storeLabels(this.names, context, subjectRefs);
  }

  /** One seller: a seller's own rate or terms touch only that seller. */
  impact(_context: CallContext, request: RevertRequest): Promise<ChangeImpact | null> {
    return oneSellerImpact(request.subjectRef);
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const admin = adminOf(context);
    const sellerId = sellerIdOf(request.subjectRef);
    const restore = rateOf(request.before.rateBps);
    const expected = rateOf(request.after.rateBps);
    if (sellerId === null || restore === undefined || expected === undefined) return 'gone';
    const settings = this.deps.policy.settings(context.market);
    if (settings === null) throw new Error('commission-payouts: the Market has no commission rate');
    const current = await this.deps.rates.findForUpdate(context.market, sellerId);
    if ((current?.rateBps ?? null) !== expected) return 'changed-since';
    if (restore === null) {
      if (current === null || !(await this.deps.rates.remove(context.market, sellerId))) {
        return 'changed-since';
      }
    } else {
      await this.deps.rates.save(context.market, {
        sellerId,
        rateBps: restore,
        updatedAt: this.deps.clock.now(),
        updatedBy: admin,
      });
    }
    await this.deps.audit.record(
      context,
      CommissionRateReverted.entry(sellerId, {
        before: { rateBps: current?.rateBps ?? null },
        after: {
          rateBps: restore,
          marketRateBps: settings.defaultRateBps,
          requestId: request.requestId,
        },
      }),
    );
    return 'reverted';
  }
}

/**
 * Restores a seller's payout terms override (or removes it when there was none before), in the
 * open unit of the decision: a new version, audited as a revert of the request, and the seller's
 * schedule worked out again, as an admin's change does. A value before that the Market's bounds no
 * longer allow is gone.
 */
export class PayoutTermsReverter implements SystemChangeReverter {
  constructor(
    private readonly deps: CommissionPayoutsDependencies,
    private readonly names: SellerNames | null = null,
  ) {}

  /** The seller's store name. */
  describe(context: CallContext, subjectRefs: readonly string[]) {
    return storeLabels(this.names, context, subjectRefs);
  }

  /** One seller: a seller's own rate or terms touch only that seller. */
  impact(_context: CallContext, request: RevertRequest): Promise<ChangeImpact | null> {
    return oneSellerImpact(request.subjectRef);
  }

  async revert(context: CallContext, request: RevertRequest): Promise<RevertOutcome> {
    const admin = adminOf(context);
    const sellerId = sellerIdOf(request.subjectRef);
    const cap = this.deps.terms.minimumCap(context.market);
    if (sellerId === null || cap === null) return 'gone';
    const parse = (value: unknown) => {
      if (value === null) return { ok: true as const, value: null };
      const parsed = parsePayoutTermsOverride(value, cap);
      return parsed.ok ? { ok: true as const, value: parsed.value } : { ok: false as const };
    };
    const restore = parse(request.before.terms);
    const expected = parse(request.after.terms);
    if (!restore.ok || !expected.ok) return 'gone';

    const current = await this.deps.termsOverrides.find(context.market, sellerId);
    const same = (a: PayoutTermsOverride | null, b: PayoutTermsOverride | null) =>
      JSON.stringify(a === null ? null : termsValues(a)) ===
      JSON.stringify(b === null ? null : termsValues(b));
    if (!same(current?.override ?? null, expected.value)) return 'changed-since';

    const now = this.deps.clock.now();
    if (restore.value === null) {
      if (current === null) return 'changed-since';
      if (!(await this.deps.termsOverrides.remove(context.market, sellerId, current.version))) {
        return 'changed-since';
      }
    } else {
      const record: PayoutTermsOverrideRecord = {
        sellerId,
        override: restore.value,
        version: (current?.version ?? 0) + 1,
        updatedAt: now,
        updatedBy: admin,
      };
      const written =
        current === null
          ? await this.deps.termsOverrides.insert(context.market, record)
          : await this.deps.termsOverrides.replace(context.market, record, current.version);
      if (!written) return 'changed-since';
    }
    // The terms that will be in force must be usable. The value before was parsed against the
    // Market's bounds above, so this fails only when the Market lost its own terms (a config
    // fault): the decision fails as a whole and the request stays open, rather than leaving the
    // seller on terms nothing can pay.
    const effective = await this.deps.terms.resolve(context.market, sellerId);
    if (!effective.ok)
      throw new Error('commission-payouts: the restored payout terms are unusable');
    const restored: PayoutTermsOverrideRecord | null =
      restore.value === null
        ? null
        : {
            sellerId,
            override: restore.value,
            version: (current?.version ?? 0) + 1,
            updatedAt: now,
            updatedBy: admin,
          };
    await this.deps.audit.record(
      context,
      PayoutTermsReverted.entry(sellerId, {
        before: termsAuditValues(current),
        after: { ...termsAuditValues(restored), requestId: request.requestId },
      }),
    );
    await announceTermsChange(this.deps, context, sellerId, now);
    return 'reverted';
  }
}
