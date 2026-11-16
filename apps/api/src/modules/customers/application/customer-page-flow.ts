import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { parseId } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { CustomerPageOpened } from '../domain/audit';
import type { CustomerListRow } from '../domain/customer-list';
import { rowView, type CustomerRowView, type CustomerListDependencies } from './customer-list-flow';

export const CUSTOMER_PAGE_TABS = ['overview', 'orders', 'money'] as const;
export type CustomerPageTab = (typeof CUSTOMER_PAGE_TABS)[number];

export interface CustomerPageDependencies extends CustomerListDependencies {
  readonly audit: AuditWriter;
  /**
   * The pending email change, read from identity at read time (customers admin email change;
   * Mohammad 10). Absent: the page shows none.
   */
  readonly pendingEmails?: {
    customerPendingEmailOf(
      context: CallContext,
      accountId: Id<'Account'>,
    ): Promise<
      Result<
        { readonly email: string; readonly requestedAt: Temporal.Instant } | null,
        { readonly code: string }
      >
    >;
  };
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
 * Opens one tab of a customer's page: reads the customer in a unit that also writes the audit row,
 * so a page that cannot be audited is not shown (the row holds the tab and the admin, never the
 * customer's data). Another Market's customer, or none, is `customers.customer-not-found`.
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
    return ok(row);
  });
}

/** The overview of one customer: the list row and what the orders add up to. */
export interface CustomerOverviewView extends CustomerRowView {
  readonly firstOrderAt: string | null;
  /** Minor units of `currency`, as digits. */
  readonly refundedMinor: string;
  /**
   * The sign-in email an admin asked for, waiting for the customer's confirmation, or null. The
   * full new address: personal data for the admin, never logged.
   */
  readonly pendingEmailChange: { readonly email: string; readonly requestedAt: string } | null;
}

export const overviewView = (
  row: CustomerListRow,
  pending: { readonly email: string; readonly requestedAt: Temporal.Instant } | null = null,
): CustomerOverviewView => ({
  ...rowView(row),
  firstOrderAt: row.firstOrderAt === null ? null : row.firstOrderAt.toString(),
  refundedMinor: row.refundedMinor.toString(),
  pendingEmailChange:
    pending === null ? null : { email: pending.email, requestedAt: pending.requestedAt.toString() },
});
