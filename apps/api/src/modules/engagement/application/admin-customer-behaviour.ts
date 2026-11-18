import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor } from '../../../platform/authz';
import {
  TOP_CATEGORIES,
  type AdminCartAddition,
  type AdminCartAdditionsRequest,
  type AdminCustomerBehaviour,
  type CustomerBehaviourFailure,
} from '../contracts/customer-behaviour.facade';
import { retentionEdges } from '../domain/behaviour-event';
import type { EngagementDependencies } from './engagement-dependencies';

// The admin's reads of one customer's behaviour (customers management phase 2b): the switch, a
// summary in counts and ids and the add-to-cart history, all of the 12 months kept. Never the
// search text. A platform admin not acting as anyone; the gate checks
// `engagement.customer-behaviour.view`.

type Dependencies = Pick<EngagementDependencies, 'unitOfWork' | 'events' | 'settings' | 'clock'>;

/** The largest page an admin's read answers (an export reads 10,000 and one more). */
const MAX_WINDOW = 10_001;

export async function readAdminCustomerBehaviour(
  deps: Dependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<AdminCustomerBehaviour, CustomerBehaviourFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const since = retentionEdges(deps.clock.now()).account;
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const setting = await deps.settings.find(context.market, accountId);
      const summary = await deps.events.summaryOfAccount(
        context.market,
        accountId,
        since,
        TOP_CATEGORIES,
      );
      return ok({ setting, summary });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { setting, summary } = read.value;
  return ok({
    personalization: {
      enabled: setting?.enabled ?? true,
      changedAt: setting?.changedAt.toString() ?? null,
    },
    summary: {
      productViews: summary.productViews,
      categoryViews: summary.categoryViews,
      cartAdditions: summary.cartAdditions,
      topCategories: summary.topCategories.map(({ categoryId, views }) => ({ categoryId, views })),
    },
  });
}

export async function readAdminCartAdditions(
  deps: Dependencies,
  context: CallContext,
  request: AdminCartAdditionsRequest,
): Promise<
  Result<
    { readonly rows: readonly AdminCartAddition[]; readonly total: number | null },
    CustomerBehaviourFailure
  >
> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const kept = retentionEdges(deps.clock.now()).account;
  const range = {
    from:
      request.from !== null && Temporal.Instant.compare(request.from, kept) > 0
        ? request.from
        : kept,
    to: request.to,
  };
  const window = {
    offset: Math.max(request.window.offset, 0),
    limit: Math.min(Math.max(request.window.limit, 0), MAX_WINDOW),
  };
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const rows = await deps.events.cartAdditionsOfAccount(
        context.market,
        request.accountId,
        range,
        request.direction,
        window,
      );
      const total = request.withTotal
        ? await deps.events.countCartAdditionsOfAccount(context.market, request.accountId, range)
        : null;
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({
    rows: read.value.rows.map((row) => ({
      offerId: row.offerId,
      variantId: row.variantId,
      addedAt: row.occurredAt.toString(),
    })),
    total: read.value.total,
  });
}
