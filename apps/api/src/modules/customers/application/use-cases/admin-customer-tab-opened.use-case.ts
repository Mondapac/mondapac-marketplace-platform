import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { adminAccountOf, invalidField, isRecord } from '../customer-list-flow';
import {
  accountIdOf,
  CUSTOMER_PAGE_TABS,
  openCustomerPage,
  type CustomerPageDependencies,
  type CustomerPageFailure,
} from '../customer-page-flow';

/**
 * `customers.admin-customer-tab-opened`: records that an admin opened the Orders or Money tab of a
 * customer's page. The tab's data comes from the owning module (the orders list with `accountId`,
 * the refunds, credits and wallet history of the account), each under its own permission; this
 * call is the audit of the open and confirms the customer is in the Market. Rule: the key
 * `customers.customers.view` and the admin population. Body: `tab` (orders or money).
 */
export class AdminCustomerTabOpened extends UseCase<
  unknown,
  { readonly opened: true },
  CustomerPageFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-tab-opened',
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
  ): Promise<Result<{ readonly opened: true }, CustomerPageFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalidField('body', 'type');
    for (const key of Object.keys(input)) {
      if (key !== 'accountId' && key !== 'tab') return invalidField(key, 'unknown');
    }
    const tab = CUSTOMER_PAGE_TABS.find((known) => known === input['tab']);
    if (tab === undefined || tab === 'overview') return invalidField('tab', 'value');
    const accountId = accountIdOf(input['accountId']);
    if (accountId === null) return err({ code: 'customers.customer-not-found' });
    const row = await openCustomerPage(this.deps, context, accountId, tab);
    return row.ok ? ok({ opened: true }) : row;
  }
}
