import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_VIEW } from '../../contracts/permissions';
import type { PayoutDependencies } from '../payout-dependencies';
import {
  listPayouts,
  type PayoutFailure,
  type PayoutListView,
  type PayoutRowView,
} from '../payout-admin-flow';

export type { PayoutListView, PayoutRowView };

type Input = { readonly status?: unknown; readonly cursor?: unknown; readonly limit?: unknown };

/** `commission-payouts.list-payouts`: an admin lists the Market's payouts, newest first, by state. */
export class ListPayouts extends UseCase<Input, PayoutListView, PayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-payouts',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listPayouts(this.deps, context, input);
  }
}
