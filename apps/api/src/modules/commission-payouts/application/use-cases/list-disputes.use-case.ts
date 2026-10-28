import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import type { DisputeDependencies } from '../dispute-dependencies';
import {
  listDisputes,
  type DisputeFailure,
  type DisputeListView,
  type DisputeRowView,
  type MoneyView,
} from '../dispute-flow';

export type { DisputeListView, DisputeRowView, MoneyView };

type Input = { readonly filter?: unknown; readonly cursor?: unknown; readonly limit?: unknown };

/** `commission-payouts.list-disputes`: an admin lists the dispute cases of the Market by bucket. */
export class ListDisputes extends UseCase<Input, DisputeListView, DisputeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-disputes',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listDisputes(this.deps, context, input);
  }
}
