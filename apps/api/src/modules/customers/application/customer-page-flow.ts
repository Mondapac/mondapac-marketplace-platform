import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { parseId } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { CustomerPageOpened } from '../domain/audit';
import type { CustomerListRow } from '../domain/customer-list';
import { rowView, type CustomerRowView, type CustomerListDependencies } from './customer-list-flow';
import type { CustomerTimelineRepository } from './ports/customer-timeline.repository';

export const CUSTOMER_PAGE_TABS = ['overview', 'orders', 'money'] as const;
export type CustomerPageTab = (typeof CUSTOMER_PAGE_TABS)[number];

export interface CustomerPageDependencies extends CustomerListDependencies {
  readonly audit: AuditWriter;
  /** Phase 2: every open is also an entry on the customer's timeline ("who looked"). */
  readonly timeline: CustomerTimelineRepository;
  readonly ids: IdGenerator;
}

export type CustomerPageFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.customer-not-found' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/** A customer id from a request; text that is no account id is the same `customer-not-found`. */
export function accountIdOf(value: unknown): Id<'Account'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'Account'>(value);
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/**
 * Opens one tab of a customer's page: reads the customer in a unit that also writes the audit row
 * and the timeline entry, so a page that cannot be audited is not shown (the row holds the tab and
 * the admin, never the customer's data). Another Market's customer, or none, is `customers.customer-not-found`.
 */
export async function openCustomerPage(
  deps: CustomerPageDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  tab: CustomerPageTab,
): Promise<Result<CustomerListRow, CustomerPageFailure>> {
  return deps.unitOfWork.run<CustomerListRow, CustomerPageFailure>(context.market, async () => {
    const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
    if (row === undefined) return err({ code: 'customers.customer-not-found' });
    await deps.audit.record(context, CustomerPageOpened.entry(accountId, { after: { tab } }));
    const admin = context.actor.kind === 'authenticated' ? context.actor.accountId : null;
    const now = deps.clock.now();
    await deps.timeline.record(
      context.market,
      {
        id: deps.ids.next<'CustomerTimelineEntry'>(),
        accountId,
        occurredAt: now,
        kind: 'page-opened',
        ref: null,
        actorAccountId: admin,
        detail: tab,
        sourceEventId: null,
      },
      now,
      // One row per admin, tab and (UTC) day: the audit log keeps every open.
      { onceSince: now.toZonedDateTimeISO('UTC').startOfDay().toInstant() },
    );
    return ok(row);
  });
}

/** The overview of one customer: the list row and what the orders add up to. */
export interface CustomerOverviewView extends CustomerRowView {
  readonly firstOrderAt: string | null;
  /** Minor units of `currency`, as digits. */
  readonly refundedMinor: string;
}

export const overviewView = (row: CustomerListRow): CustomerOverviewView => ({
  ...rowView(row),
  firstOrderAt: row.firstOrderAt === null ? null : row.firstOrderAt.toString(),
  refundedMinor: row.refundedMinor.toString(),
});
