import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CUSTOMER_EXPORT_MAX_ROWS } from '../../domain/customer-list';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  selectorOfRequest,
  type CustomerListDependencies,
  type ListValidationFailure,
} from '../customer-list-flow';

export interface AdminCustomersIdsOutput {
  readonly ids: readonly string[];
  readonly total: number;
}

export type AdminCustomersIdsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total: number }
  | ListValidationFailure;

/**
 * `customers.admin-customers-ids`: the account ids a tab, search and filters match, for "select all
 * matching" (the page then acts on the ids, for example the export). At most
 * {@link CUSTOMER_EXPORT_MAX_ROWS}; more is refused whole with the total, and the admin narrows the
 * filter. Same body keys as the list without sort and paging. Rule: `customers.customers.view`.
 */
export class AdminCustomersIds extends UseCase<
  unknown,
  AdminCustomersIdsOutput,
  AdminCustomersIdsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customers-ids',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<AdminCustomersIdsOutput, AdminCustomersIdsFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalidField('body', 'type');
    for (const key of Object.keys(input)) {
      if (key !== 'view' && key !== 'q' && key !== 'filters') return invalidField(key, 'unknown');
    }
    const selector = selectorOfRequest(input);
    if (!selector.ok) return selector;
    const { deps } = this;
    const query = {
      selector: selector.value,
      now: deps.clock.now(),
      zone: await deps.dayZone.zoneOf(context),
    };
    const read = await deps.unitOfWork.run(
      context.market,
      async () => {
        const ids = await deps.listReader.ids(context.market, query, CUSTOMER_EXPORT_MAX_ROWS + 1);
        const total =
          ids.length <= CUSTOMER_EXPORT_MAX_ROWS
            ? ids.length
            : await deps.listReader.count(context.market, query);
        return ok({ ids, total });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value.ids.length > CUSTOMER_EXPORT_MAX_ROWS) {
      return err({
        code: 'batch.too-large',
        max: CUSTOMER_EXPORT_MAX_ROWS,
        total: read.value.total,
      });
    }
    return ok({ ids: read.value.ids, total: read.value.total });
  }
}
