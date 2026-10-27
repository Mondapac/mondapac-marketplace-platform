import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import type { DisputeDependencies } from '../dispute-dependencies';
import {
  viewDispute,
  type DecisionView,
  type DisputeDetailView,
  type DisputeFailure,
  type DisputeSellerOrderView,
  type TimelineView,
} from '../dispute-flow';

export type { DecisionView, DisputeDetailView, DisputeSellerOrderView, TimelineView };

type Input = { readonly disputeId: unknown };

/** `commission-payouts.view-dispute`: an admin reads one case with its seller orders and timeline. */
export class ViewDispute extends UseCase<Input, DisputeDetailView, DisputeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-dispute',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewDispute(this.deps, context, input);
  }
}
