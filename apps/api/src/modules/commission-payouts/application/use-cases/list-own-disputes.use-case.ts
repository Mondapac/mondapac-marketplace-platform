import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { DisputeDependencies } from '../dispute-dependencies';
import { listOwnDisputes, type DisputeFailure, type OwnDisputeView } from '../dispute-flow';

export type { OwnDisputeView };

/**
 * `commission-payouts.list-own-disputes`: the signed-in seller's seller orders a dispute holds or
 * held (own resources). No reason, evidence date, provider id or buyer data.
 */
export class ListOwnDisputes extends UseCase<void, readonly OwnDisputeView[], DisputeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-own-disputes',
    rule: { kind: 'own-resources' },
    // A seller whose access was suspended still sees what holds its money.
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listOwnDisputes(this.deps, context);
  }
}
