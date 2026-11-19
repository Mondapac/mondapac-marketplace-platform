import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, IdGenerator, Result, Temporal } from '@mondapac/shared-kernel';
import { parseId } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { CustomerPageOpened } from '../domain/audit';
import type { AccountDeletionRequest } from '../domain/account-deletion-request';
import type { CustomerListRow } from '../domain/customer-list';
import { rowView, type CustomerRowView, type CustomerListDependencies } from './customer-list-flow';
import type { AccountDeletionRequestRepository } from './ports/account-deletion-request.repository';
import type { CustomerTimelineRepository } from './ports/customer-timeline.repository';

export const CUSTOMER_PAGE_TABS = ['overview', 'orders', 'money'] as const;
export type CustomerPageTab = (typeof CUSTOMER_PAGE_TABS)[number];

export interface CustomerPageDependencies extends CustomerListDependencies {
  readonly audit: AuditWriter;
  /** The account's open deletion request, shown on the Overview (same module's own table). */
  readonly deletionRequests: Pick<AccountDeletionRequestRepository, 'findActiveOf'>;
  /** Phase 2: every open is also an entry on the customer's timeline ("who looked"). */
  readonly timeline: CustomerTimelineRepository;
  readonly ids: IdGenerator;
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
  /** Phase 2b: an erased customer's page answers a tombstone (when the erasure completed). */
  readonly deletions: Pick<AccountDeletionRequestRepository, 'completedAt'>;
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
): Promise<Result<CustomerPageRead, CustomerPageFailure>> {
  return deps.unitOfWork.run<CustomerPageRead, CustomerPageFailure>(context.market, async () => {
    const [row] = await deps.listReader.rowsByIds(context.market, [accountId]);
    if (row === undefined) return err({ code: 'customers.customer-not-found' });
    const deletion =
      tab === 'overview'
        ? await deps.deletionRequests.findActiveOf(context.market, accountId)
        : null;
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
    return ok({ row, deletion });
  });
}

/** What one open of the page reads: the row and, on the Overview, the open deletion request. */
export interface CustomerPageRead {
  readonly row: CustomerListRow;
  readonly deletion: AccountDeletionRequest | null;
}

/**
 * What the page shows of a customer whose account was erased (account deletion completed): the id
 * and when, nothing else (no name, no address, no totals). Instead of not-found, so an admin who
 * follows an old link sees what happened.
 */
export interface CustomerTombstoneView {
  readonly accountId: string;
  readonly status: 'deleted';
  /** When the erasure completed (ISO 8601, UTC). */
  readonly deletedAt: string;
}

/**
 * The tombstone of an erased customer, in a unit that also writes the page-open audit row (no
 * timeline entry: the timeline went with the account). `customers.customer-not-found` when the
 * account was never erased here (unknown, another Market's).
 */
export async function openCustomerTombstone(
  deps: CustomerPageDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<CustomerTombstoneView, CustomerPageFailure>> {
  return deps.unitOfWork.run<CustomerTombstoneView, CustomerPageFailure>(
    context.market,
    async () => {
      const deletedAt = await deps.deletions.completedAt(context.market, accountId);
      if (deletedAt === null) return err({ code: 'customers.customer-not-found' });
      await deps.audit.record(
        context,
        CustomerPageOpened.entry(accountId, { after: { tab: 'overview' } }),
      );
      return ok({ accountId, status: 'deleted', deletedAt: deletedAt.toString() });
    },
  );
}

/** The overview of one customer: the list row and what the orders add up to. */
export interface CustomerOverviewView extends CustomerRowView {
  readonly firstOrderAt: string | null;
  /** Minor units of `currency`, as digits. */
  readonly refundedMinor: string;
  /**
   * The account's open deletion request (pending: it can still be cancelled; executing: it is
   * being carried out), or null. The page shows it and offers no second request.
   */
  readonly deletionRequest: {
    readonly requestId: string;
    readonly status: 'pending' | 'executing';
    readonly requestedAt: string;
    readonly scheduledFor: string;
  } | null;
  /**
   * The sign-in email an admin asked for, waiting for the customer's confirmation, or null. The
   * full new address: personal data for the admin, never logged.
   */
  readonly pendingEmailChange: { readonly email: string; readonly requestedAt: string } | null;
}

export const overviewView = (
  { row, deletion }: CustomerPageRead,
  pending: { readonly email: string; readonly requestedAt: Temporal.Instant } | null = null,
): CustomerOverviewView => ({
  ...rowView(row),
  firstOrderAt: row.firstOrderAt === null ? null : row.firstOrderAt.toString(),
  refundedMinor: row.refundedMinor.toString(),
  deletionRequest:
    deletion === null || (deletion.status !== 'pending' && deletion.status !== 'executing')
      ? null
      : {
          requestId: deletion.id,
          status: deletion.status,
          requestedAt: deletion.requestedAt.toString(),
          scheduledFor: deletion.scheduledFor.toString(),
        },
  pendingEmailChange:
    pending === null ? null : { email: pending.email, requestedAt: pending.requestedAt.toString() },
});
