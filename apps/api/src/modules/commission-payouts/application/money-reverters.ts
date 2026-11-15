import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { RevertOutcome, RevertRequest, SystemChangeReverter } from '../../system-requests';
import {
  CommissionRateCleared,
  CommissionRateSet,
  PayoutTermsCleared,
  PayoutTermsSet,
} from '../domain/audit';
import { parsePayoutTermsOverride, type PayoutTermsOverride } from '../domain/payout-terms';
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

const rateOf = (value: unknown): number | null | undefined =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ? value
    : undefined;

/**
 * Restores a seller's own rate (or removes it when there was none before), in the open unit of
 * the decision, with the same audit row as an admin's change. Applies to orders placed after it.
 */
export class CommissionRateReverter implements SystemChangeReverter {
  constructor(private readonly deps: CommissionPayoutsDependencies) {}

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
      await this.deps.audit.record(
        context,
        CommissionRateCleared.entry(sellerId, {
          before: { rateBps: current.rateBps },
          after: { marketRateBps: settings.defaultRateBps },
        }),
      );
      return 'reverted';
    }
    await this.deps.rates.save(context.market, {
      sellerId,
      rateBps: restore,
      updatedAt: this.deps.clock.now(),
      updatedBy: admin,
    });
    await this.deps.audit.record(
      context,
      CommissionRateSet.entry(sellerId, {
        before: { rateBps: current?.rateBps ?? null },
        after: {
          rateBps: restore,
          marketRateBps: settings.defaultRateBps,
          belowMarketRate: restore < settings.defaultRateBps,
        },
      }),
    );
    return 'reverted';
  }
}

/**
 * Restores a seller's payout terms override (or removes it when there was none before), in the
 * open unit of the decision: a new version, audited with reason `correction`, and the seller's
 * schedule worked out again, as an admin's change does. A value before that the Market's bounds no
 * longer allow is gone.
 */
export class PayoutTermsReverter implements SystemChangeReverter {
  constructor(private readonly deps: CommissionPayoutsDependencies) {}

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
    // The terms that will be in force must be usable; a Market without terms cannot be paid.
    const effective = await this.deps.terms.resolve(context.market, sellerId);
    if (!effective.ok)
      throw new Error('commission-payouts: the restored payout terms are unusable');
    if (restore.value === null) {
      await this.deps.audit.record(
        context,
        PayoutTermsCleared.entry(sellerId, {
          before: termsAuditValues(current),
          after: { version: null, reasonCode: 'correction' },
        }),
      );
    } else {
      await this.deps.audit.record(
        context,
        PayoutTermsSet.entry(sellerId, {
          before: termsAuditValues(current),
          after: {
            ...termsAuditValues({
              sellerId,
              override: restore.value,
              version: (current?.version ?? 0) + 1,
              updatedAt: now,
              updatedBy: admin,
            }),
            reasonCode: 'correction',
          },
        }),
      );
    }
    await announceTermsChange(this.deps, context, sellerId, now);
    return 'reverted';
  }
}
