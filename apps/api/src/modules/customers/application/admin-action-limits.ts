import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { AdminBulkPiiReveal } from '../../../platform/security-events/security-event-catalogue';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AdminActionLimits, AdminLimitedAction } from './ports/admin-action-limits';

// Per-admin limits on the customer page's actions on personal data (security review of #969,
// L2/L3): "send password reset", and the reveals of a sign-in's address and of a delivery address
// (one shared count). The count is taken after the gate has authorised the call and the input is
// well formed, and before the customer is looked up, so an unknown customer or address counts
// too (no free probing). Every counted attempt counts, a refused one included: the windows are
// fixed, so an admin who keeps trying past the limit does not push the window's end out, and the
// count stays one atomic step on the shared table. A counter that cannot be read refuses (fail
// closed). When the reveal count reaches the Market's alert count, one security event is recorded
// for the admin (rule `admin-bulk-pii-reveal`); only the one attempt that reaches it exactly
// records it, so the alert is raised once per admin and window.

export type AdminActionRefusal =
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

export interface AdminActionLimitDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminLimits: AdminActionLimits;
  readonly securityEvents: SecurityEvents;
}

const logger = new Logger('CustomersAdminActionLimits');

/** The subject of an admin's counters: the account with its Market. */
const subjectOf = (context: CallContext, admin: Id<'Account'>): string =>
  `${context.market.marketId}:${admin}`;

/**
 * Counts one attempt of `action` by `admin` and answers whether it may go on: `request.throttled`
 * past the Market's limit, `access.unavailable` when the Market has no limits, the counter cannot
 * be read or the bulk-reveal alert cannot be recorded.
 */
export async function admitAdminAction(
  deps: AdminActionLimitDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  action: AdminLimitedAction,
  name: string,
): Promise<Result<true, AdminActionRefusal>> {
  const settings = deps.adminLimits.settings(context.market);
  if (settings === null) {
    logger.warn({
      msg: name,
      code: 'admin-limits-not-configured',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
  let counted;
  try {
    counted = await deps.adminLimits.count(action, subjectOf(context, admin));
  } catch {
    logger.warn({
      msg: name,
      code: 'admin-limit-counter-unavailable',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
  const limit =
    action === 'password-reset' ? settings.passwordResetsPerHour : settings.piiRevealsPerHour;
  if (counted.count > limit) {
    logger.warn({
      msg: name,
      code: 'request.throttled',
      adminAccountId: admin,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'request.throttled', retryAfterSeconds: counted.retryAfterSeconds });
  }
  if (action === 'pii-reveal' && counted.count === settings.piiRevealAlertAt) {
    const recorded = await recordBulkReveal(deps, context, admin, counted.count);
    if (!recorded) {
      // The alert is the point of the count: a reveal whose alert cannot be raised shows nothing.
      logger.error({
        msg: name,
        code: 'bulk-reveal-alert-not-recorded',
        adminAccountId: admin,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    logger.warn({
      msg: name,
      code: 'bulk-reveal-alert-raised',
      adminAccountId: admin,
      reveals: counted.count,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
  return ok(true);
}

async function recordBulkReveal(
  deps: AdminActionLimitDependencies,
  context: CallContext,
  admin: Id<'Account'>,
  reveals: number,
): Promise<boolean> {
  try {
    const written = await deps.unitOfWork.run(context.market, async () => {
      await deps.securityEvents.record(
        context,
        AdminBulkPiiReveal.event({ targetId: admin, payload: { reveals } }),
      );
      return ok(true);
    });
    return written.ok;
  } catch {
    return false;
  }
}
