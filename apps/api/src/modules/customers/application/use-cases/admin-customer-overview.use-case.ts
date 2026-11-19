import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { adminAccountOf, invalidField, isRecord } from '../customer-list-flow';
import {
  accountIdOf,
  openCustomerPage,
  openCustomerTombstone,
  overviewView,
  type CustomerOverviewView,
  type CustomerTombstoneView,
  type CustomerPageDependencies,
  type CustomerPageFailure,
} from '../customer-page-flow';

/**
 * `customers.admin-customer-overview`: one customer's header and Overview tab: the account's
 * profile (address, name, status, verified, joined) and what the orders add up to (count, spent,
 * refunds, first and last order), and a pending sign-in email change read from identity. The wallet balance, orders, refunds and credits are read from
 * their owning modules by account id, each under its own permission. Rule: the key
 * `customers.customers.view` and the admin population. Every open writes an audit row (the tab,
 * never the customer's data); a customer of another Market, or none, is
 * `customers.customer-not-found`. An erased customer (account deletion completed) is a tombstone:
 * `{ accountId, status: 'deleted', deletedAt }` (phase 2b). The answer is personal data and is never logged.
 */
export class AdminCustomerOverview extends UseCase<
  unknown,
  CustomerOverviewView | CustomerTombstoneView,
  CustomerPageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-overview',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPageDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CustomerOverviewView | CustomerTombstoneView, CustomerPageFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalidField('query', 'type');
    for (const key of Object.keys(input))
      if (key !== 'accountId') return invalidField(key, 'unknown');
    const accountId = accountIdOf(input['accountId']);
    if (accountId === null) return err({ code: 'customers.customer-not-found' });
    const row = await openCustomerPage(this.deps, context, accountId, 'overview');
    if (!row.ok) {
      if (row.error.code !== 'customers.customer-not-found') return row;
      return openCustomerTombstone(this.deps, context, accountId);
    }
    const reader = this.deps.pendingEmails;
    if (reader === undefined) return ok(overviewView(row.value));
    const pending = await reader.customerPendingEmailOf(context, accountId);
    if (!pending.ok) {
      return err(
        pending.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'access.unavailable' },
      );
    }
    return ok(overviewView(row.value, pending.value));
  }
}
