import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import { exclusiveRateBps } from '../domain/commission';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import { sellerIdOf } from './rate-flow';

// The seller's lower commission on its exclusive customers and what it saved (customers
// management phase 4b, for the seller's Exclusive perks page). The rule is the Market's, applied
// to the seller's rate in force now; the savings are read from the ledger rows of lowered lines
// (the commission the standard rate would have taken less what was taken, refunds given back).

export type ExclusiveCommissionFailure =
  { readonly code: 'access.denied' } | { readonly code: 'commission-payouts.rate-unavailable' };

/** The months of savings shown: this month and the 11 before it. */
export const SAVINGS_MONTHS = 12;

export interface ExclusiveCommissionRuleView {
  /** The seller's rate in force now: its own if an admin set one, else the Market's. */
  readonly standardRateBps: number;
  /** The rate its exclusive customers' lines carry now (never above `standardRateBps`). */
  readonly exclusiveRateBps: number;
  /** How many months after a customer joined the lower rate applies. */
  readonly months: number;
}

export interface SavingsMonth {
  /** `YYYY-MM` in `zone`. */
  readonly month: string;
  /**
   * Per currency, by code: what the month saved less what its refunds gave back (negative when an
   * earlier month's order was refunded this month); empty when it nets to nothing.
   */
  readonly saved: readonly Money[];
}

export interface ExclusiveCommissionView {
  /** Null when the Market has no lower commission for exclusive customers. */
  readonly rule: ExclusiveCommissionRuleView | null;
  /** The IANA zone the months are cut in (the Market's; ADR-0005 fallback). */
  readonly zone: string;
  /** The last 12 months, oldest first; the last one is this month. */
  readonly months: readonly SavingsMonth[];
}

/** The calendar months `[from, to)` ending with the one `now` is in, in `zone`, oldest first. */
export function savingsMonths(
  now: Temporal.Instant,
  zone: string,
  count: number = SAVINGS_MONTHS,
): readonly {
  readonly month: string;
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
}[] {
  const today = now.toZonedDateTimeISO(zone).toPlainDate();
  const current = Temporal.PlainYearMonth.from({ year: today.year, month: today.month });
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const month = current.subtract({ months: back });
    months.push({
      month: month.toString(),
      from: month.toPlainDate({ day: 1 }).toZonedDateTime({ timeZone: zone }).toInstant(),
      to: month
        .add({ months: 1 })
        .toPlainDate({ day: 1 })
        .toZonedDateTime({ timeZone: zone })
        .toInstant(),
    });
  }
  return months;
}

/**
 * The signed-in seller's lower commission on exclusive customers and its savings by month. The
 * seller is the session's, never a request field: a seller sees only its own. Deliberately not
 * refused for an acting-as (Login as Seller) session, as the seller's ledger is not: read-only, and
 * the admin already sees that seller's ledger (Hassan L2). The gate mints no acting-as marker
 * today, so there is no such context to test yet.
 */
export async function viewOwnExclusiveCommission(
  deps: CommissionPayoutsDependencies,
  context: CallContext,
): Promise<Result<ExclusiveCommissionView, ExclusiveCommissionFailure>> {
  const actor = context.actor;
  const sellerId: Id<'Seller'> | null =
    actor.kind === 'authenticated' && actor.population === 'seller'
      ? sellerIdOf(actor.sellerId)
      : null;
  if (sellerId === null) return err({ code: 'access.denied' });
  const settings = deps.policy.settings(context.market);
  if (settings === null) return err({ code: 'commission-payouts.rate-unavailable' });
  const zone = settings.timeZone;
  const windows = savingsMonths(deps.clock.now(), zone);
  return deps.unitOfWork.run<ExclusiveCommissionView, ExclusiveCommissionFailure>(
    context.market,
    async () => {
      const [[own], savings] = await Promise.all([
        deps.rates.findMany(context.market, [sellerId]),
        deps.ledger.savingsBetween(context.market, sellerId, windows),
      ]);
      const standard = own?.rateBps ?? settings.defaultRateBps;
      const rule = settings.exclusiveCustomer;
      return ok({
        rule:
          rule === null
            ? null
            : {
                standardRateBps: standard,
                exclusiveRateBps: exclusiveRateBps(standard, rule),
                months: rule.months,
              },
        zone,
        months: windows.map(({ month }, index) => ({
          month,
          saved: (savings[index] ?? []).map((row) => money(row.saved, row.currency)),
        })),
      });
    },
    { readOnly: true },
  );
}
