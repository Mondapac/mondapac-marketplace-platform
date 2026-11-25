import { err, ok, parseMinorUnits, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { sessionSellerOf } from '../../../../platform/work-queue/count-work-queue';
import { isActingAsSession } from '../acting-as';
import { REPORTING_SELLER_GOAL_MANAGE } from '../../contracts/permissions';
import { SellerMonthlyGoalChanged as GoalChanged } from '../../domain/audit';
import { calendarMonthFrom, monthWindowOf, type CalendarMonth } from '../../domain/month-forecast';
import type { SellerGoalDependencies } from './view-seller-monthly-goal.use-case';

/** How far ahead a goal may be set: this month and the next twelve. */
export const GOAL_MONTHS_AHEAD = 12;
/** The most digits of a goal (inside a BIGINT, below 2^53; the table's CHECK). */
const MAX_GOAL_DIGITS = 15;

export interface SetSellerGoalInput {
  /** `YYYY-MM`, a month of the Market's zone. */
  readonly month?: unknown;
  /** Minor units above zero, as a decimal string. */
  readonly amount?: unknown;
  /** ISO 4217: must be the Market's currency. */
  readonly currency?: unknown;
  /** The version the seller saw (0: no goal yet). */
  readonly expectedVersion?: unknown;
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

export type SetSellerGoalFailure =
  | AccessDenied
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  /** Someone else changed the month's goal first; reload and try again. */
  | { readonly code: 'reporting.seller-goal-conflict' };

export interface SetSellerGoalAnswer {
  readonly month: CalendarMonth;
  readonly goal: Money;
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
}

/**
 * `reporting.set-seller-monthly-goal` (dashboards v2, phase 2): the session seller sets the shop's
 * sales goal (with GST) for this calendar month of the Market's zone or one of the next twelve,
 * in the Market's own currency, from the version they saw (a stale edit is a conflict). Key
 * `reporting.seller-goal.manage` (a seller key), denied while the seller is not approved; always
 * the session's seller, never an id from input. Refused in an acting-as (Login as Seller) session,
 * fail closed, until SEL-08 names the admin (FE-20261125-seller-goal-login-as-seller). Audited; the goal already in force changes nothing. No
 * goal is removed here (FE row): a goal is changed, not deleted.
 */
export class SetSellerMonthlyGoal extends UseCase<
  SetSellerGoalInput,
  SetSellerGoalAnswer,
  SetSellerGoalFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.set-seller-monthly-goal',
    rule: { kind: 'permissions', allOf: [REPORTING_SELLER_GOAL_MANAGE.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerGoalDependencies & { readonly audit: AuditWriter },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SetSellerGoalInput,
  ): Promise<Result<SetSellerGoalAnswer, SetSellerGoalFailure>> {
    const sellerId = sessionSellerOf(context);
    const actor = context.actor;
    if (sellerId === null || actor.kind !== 'authenticated' || isActingAsSession(actor)) {
      return err({ code: 'access.denied' });
    }
    const { market } = context;
    const now = this.deps.clock.now();
    const timezone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const current = monthWindowOf(now, timezone).month;
    const fields: FieldIssue[] = [];
    const month = calendarMonthFrom(input?.month);
    if (month === null) {
      fields.push({ path: 'month', code: 'format' });
    } else {
      const first = Temporal.PlainYearMonth.from(current);
      const asked = Temporal.PlainYearMonth.from(month);
      if (
        Temporal.PlainYearMonth.compare(asked, first) < 0 ||
        Temporal.PlainYearMonth.compare(asked, first.add({ months: GOAL_MONTHS_AHEAD })) > 0
      ) {
        fields.push({ path: 'month', code: 'range' });
      }
    }
    const amount = parseMinorUnits(input?.amount, MAX_GOAL_DIGITS);
    if (!amount.ok || amount.value <= 0n) fields.push({ path: 'amount', code: 'value' });
    if (input?.currency !== currency) fields.push({ path: 'currency', code: 'value' });
    const seen = input?.expectedVersion;
    if (!Number.isSafeInteger(seen) || (seen as number) < 0) {
      fields.push({ path: 'expectedVersion', code: 'type' });
    }
    if (fields.length > 0 || month === null || !amount.ok) {
      return err({ code: 'validation.failed', fields });
    }
    const goal: Money = Object.freeze({ amount: amount.value, currency });
    const monthStart = Temporal.PlainDate.from(`${month}-01`)
      .toZonedDateTime({ timeZone: timezone })
      .toInstant();
    return this.deps.unitOfWork.run<SetSellerGoalAnswer, SetSellerGoalFailure>(market, async () => {
      const before = await this.deps.goals.find(market, sellerId, month);
      const version = before?.version ?? 0;
      if (version !== seen) return err({ code: 'reporting.seller-goal-conflict' });
      if (
        before !== null &&
        before.goal.amount === goal.amount &&
        before.goal.currency === goal.currency
      ) {
        return ok({ month, goal: before.goal, version, updatedAt: before.updatedAt });
      }
      const saved = await this.deps.goals.save(market, {
        sellerId,
        month,
        goal,
        version: version + 1,
        changedAt: now,
      });
      if (!saved) return err({ code: 'reporting.seller-goal-conflict' });
      await this.deps.audit.record(
        context,
        GoalChanged.entry(sellerId, {
          before: { goal: before?.goal ?? null },
          after: { monthStart, goal, version: version + 1 },
        }),
      );
      return ok({ month, goal, version: version + 1, updatedAt: now });
    });
  }
}
