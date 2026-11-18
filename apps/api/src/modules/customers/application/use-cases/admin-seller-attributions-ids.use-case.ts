import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { adminOfCall, invalid, isRecord } from '../seller-customers-flow';
import {
  ATTRIBUTION_MAX_SELECTED,
  attributionSelectorOf,
  type InvitationDependencies,
  type InvitationFailure,
} from '../seller-invitations-flow';

export type AttributionIdsFailure =
  | InvitationFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total: number };

/** The accounts "select all matching" acts on, as the Customers list answers it. */
export interface AttributionIdsOutput {
  readonly ids: readonly string[];
  readonly total: number;
}

/**
 * `customers.admin-seller-attributions-ids`: the accounts the attributions list matches ("select all
 * matching"), at most 10,000; more is refused with the total. Rule `customers.customers.view`.
 */
export class AdminSellerAttributionsIds extends UseCase<
  unknown,
  AttributionIdsOutput,
  AttributionIdsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-attributions-ids',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<AttributionIdsOutput, AttributionIdsFailure>> {
    if (adminOfCall(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    for (const key of Object.keys(input)) {
      if (key !== 'view' && key !== 'q' && key !== 'filters') return invalid(key, 'unknown');
    }
    const selector = attributionSelectorOf(input);
    if (!selector.ok) return selector;
    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork.run<AttributionIdsOutput, AttributionIdsFailure>(
      market,
      async () => {
        const ids = await deps.attributions.accountIds(
          market,
          selector.value,
          ATTRIBUTION_MAX_SELECTED + 1,
        );
        if (ids.length > ATTRIBUTION_MAX_SELECTED) {
          const total = await deps.attributions.count(market, selector.value);
          return err({ code: 'batch.too-large', max: ATTRIBUTION_MAX_SELECTED, total });
        }
        return ok({ ids, total: ids.length });
      },
      { readOnly: true },
    );
    return read;
  }
}
