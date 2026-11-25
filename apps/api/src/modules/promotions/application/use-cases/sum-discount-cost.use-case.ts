import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../../commission-payouts';
import { PROMOTIONS_PROMOTION_MANAGE } from '../../contracts/permissions';
import {
  MAX_DISCOUNT_COST_WINDOW_DAYS,
  type DiscountCostFailure,
  type DiscountCostRequest,
  type DiscountCostTotals,
} from '../../contracts/promotions-reporting.facade';
import type { PromotionsDependencies } from '../promotions-dependencies';

const logger = new Logger('SumDiscountCost');

const DAY_MS = 86_400_000;

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/**
 * `promotions.sum-discount-cost` (dashboards v2, phase 2): the discount cost of the orders whose
 * payment was confirmed in a window, in one currency, for reporting's admin dashboard section.
 * What still stands, split by who funded it and by kind, and what those orders gave back since
 * (refunded or cancelled after payment). Totals only: no order, customer, code or promotion
 * leaves the module.
 *
 * Rule: both `commission-payouts.settlement.view` (the dashboard's money key) and
 * `promotions.promotion.manage` (in promotions, spend is for managers: a holder of
 * `promotions.promotion.view` alone, such as the default Viewer, sees usage counts only; owner
 * decision of 28 October); a platform admin acting as themselves only. The window is at most {@link MAX_DISCOUNT_COST_WINDOW_DAYS}
 * days (13 months of Market days). One read-only unit (ADR-0025).
 */
export class SumDiscountCost extends UseCase<
  DiscountCostRequest,
  DiscountCostTotals,
  DiscountCostFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.sum-discount-cost',
    rule: {
      kind: 'permissions',
      allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key, PROMOTIONS_PROMOTION_MANAGE.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<PromotionsDependencies, 'unitOfWork' | 'redemptions'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: DiscountCostRequest,
  ): Promise<Result<DiscountCostTotals, DiscountCostFailure>> {
    if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
    const window = input?.window;
    if (!isInstant(window?.from) || !isInstant(window.to)) {
      return err({ code: 'validation.failed' });
    }
    const span = window.to.epochMilliseconds - window.from.epochMilliseconds;
    if (!(span > 0) || span > MAX_DISCOUNT_COST_WINDOW_DAYS * DAY_MS) {
      return err({ code: 'validation.failed' });
    }
    const currency = input.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      return err({ code: 'validation.failed' });
    }
    try {
      const unit = await this.deps.unitOfWork.run(
        context.market,
        async () =>
          ok(
            await this.deps.redemptions.discountCost(context.market, currency, {
              from: window.from,
              to: window.to,
            }),
          ),
        { readOnly: true },
      );
      return unit.ok ? unit : err({ code: 'promotions.unavailable' });
    } catch (error) {
      logger.warn({
        msg: 'promotions.discount-cost.read-failed',
        thrown:
          error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.constructor.name)
            ? error.constructor.name
            : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'promotions.unavailable' });
    }
  }
}
