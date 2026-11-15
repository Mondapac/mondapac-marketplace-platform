import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { CustomerDirectoryEntry, CustomerStatsEntry } from '../domain/customer-read-models';
import type { DirectoryRecordPeer } from './ports/customer-read-model-peers';
import type { ReadModelDependencies } from './read-model-dependencies';

export type ReadModelFailure =
  /** A peer could not answer: the caller retries (an event delivery throws, the job logs). */
  { readonly code: 'customers.unavailable' } | { readonly code: 'validation.failed' };

const DIRECTORY_PAGE = 200;
const ORDER_ACCOUNT_PAGE = 200;
/** The most pages one reconcile run walks per phase (40,000 customers); the next night continues from the start, so a Market this size is reconciled by the events. */
const MAX_PAGES = 200;

function toDirectoryEntry(record: DirectoryRecordPeer): CustomerDirectoryEntry {
  return {
    accountId: record.accountId,
    email: record.email,
    displayName: record.displayName,
    status: record.status,
    emailVerified: record.emailVerifiedAt !== null,
    signedUpAt: record.signedUpAt,
  };
}

/**
 * Brings one customer's two read model rows in line with their owners: the account is read from
 * `identity` and the order totals from `ordering`, both before any unit opens, and the rows are
 * written in one unit. The write replaces, never increments, so a repeated or late event changes
 * nothing. An account `identity` no longer has (erased) loses both rows; stats are kept only for an
 * account with a directory row. With a `delivery` the unit is the subscriber's once-only unit.
 */
export async function syncCustomer(
  deps: ReadModelDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  delivery: EventDelivery | null,
): Promise<Result<{ readonly kept: boolean }, ReadModelFailure>> {
  const records = await deps.identity.customerDirectoryRecords(context, [accountId]);
  if (!records.ok) return err({ code: 'customers.unavailable' });
  const record = records.value.find((candidate) => candidate.accountId === accountId) ?? null;

  let stats: CustomerStatsEntry | null = null;
  if (record !== null) {
    const totals = await deps.ordering.customerOrderStats(context, accountId);
    if (!totals.ok) return err({ code: 'customers.unavailable' });
    stats = {
      accountId,
      firstOrderAt: totals.value.firstOrderAt,
      lastOrderAt: totals.value.lastOrderAt,
      orderCount: totals.value.orderCount,
      spentMinor: totals.value.spentMinor ?? 0n,
      currency: totals.value.currency,
      refundCount: totals.value.refundCount,
      refundedMinor: totals.value.refundedMinor,
    };
  }

  const work = async (): Promise<Result<{ readonly kept: boolean }, ReadModelFailure>> => {
    const now = deps.clock.now();
    if (record === null || stats === null) {
      await deps.readModels.removeAllOf(context.market, accountId);
      return ok({ kept: false });
    }
    await deps.readModels.upsertDirectory(context.market, toDirectoryEntry(record), now);
    await deps.readModels.upsertStats(context.market, stats, now);
    return ok({ kept: true });
  };
  if (delivery === null) return deps.unitOfWork.run(context.market, work);
  const handled = await deps.unitOfWork.runOnce(context.market, delivery, work);
  return handled.ok ? ok(handled.value.handled ? handled.value.value : { kept: true }) : handled;
}

/** The account that paid a confirmed order, through `ordering`. */
export async function accountOfOrder(
  deps: ReadModelDependencies,
  context: CallContext,
  orderId: string,
): Promise<Result<Id<'Account'>, ReadModelFailure>> {
  const notice = await deps.ordering.orderNotice(context, orderId);
  return notice.ok ? ok(notice.value.accountId) : err({ code: 'customers.unavailable' });
}

/** The account a refund went back to, through `ordering`. */
export async function accountOfRefund(
  deps: ReadModelDependencies,
  context: CallContext,
  orderId: string,
  refundId: string,
): Promise<Result<Id<'Account'>, ReadModelFailure>> {
  const notice = await deps.ordering.refundNotice(context, { orderId, refundId });
  return notice.ok ? ok(notice.value.accountId) : err({ code: 'customers.unavailable' });
}

export interface ReconcileCounts {
  readonly directoryRows: number;
  readonly customersWithOrders: number;
}

/**
 * The one-off backfill and the nightly reconcile in one run: every customer account `identity`
 * has gets its directory row (a keyset walk), then every account with a confirmed order gets its
 * stats refreshed. Safe to run twice and concurrently: every write replaces.
 */
export async function reconcileReadModels(
  deps: ReadModelDependencies,
  context: CallContext,
): Promise<Result<ReconcileCounts, ReadModelFailure>> {
  let directoryRows = 0;
  let after: Id<'Account'> | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await deps.identity.customerDirectoryPage(context, {
      after,
      limit: DIRECTORY_PAGE,
    });
    if (!rows.ok) return err({ code: 'customers.unavailable' });
    if (rows.value.length === 0) break;
    const written = await deps.unitOfWork.run<number, ReadModelFailure>(
      context.market,
      async () => {
        const now = deps.clock.now();
        for (const record of rows.value) {
          await deps.readModels.upsertDirectory(context.market, toDirectoryEntry(record), now);
        }
        return ok(rows.value.length);
      },
    );
    if (!written.ok) return written;
    directoryRows += written.value;
    after = rows.value[rows.value.length - 1]!.accountId;
    if (rows.value.length < DIRECTORY_PAGE) break;
  }

  let customersWithOrders = 0;
  after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const accounts = await deps.ordering.customerOrderAccounts(context, {
      after,
      limit: ORDER_ACCOUNT_PAGE,
    });
    if (!accounts.ok) return err({ code: 'customers.unavailable' });
    if (accounts.value.accountIds.length === 0) break;
    for (const accountId of accounts.value.accountIds) {
      const synced = await syncCustomer(deps, context, accountId, null);
      if (!synced.ok) return synced;
      customersWithOrders += 1;
    }
    after = accounts.value.accountIds[accounts.value.accountIds.length - 1]!;
    if (accounts.value.accountIds.length < ORDER_ACCOUNT_PAGE) break;
  }
  return ok({ directoryRows, customersWithOrders });
}
