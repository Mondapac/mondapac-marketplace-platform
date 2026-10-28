import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE } from '../../contracts/permissions';
import type { DisputeDependencies } from '../dispute-dependencies';
import { decideDispute, type DisputeDecisionView, type DisputeFailure } from '../dispute-flow';

export type { DisputeDecisionView };

type Input = {
  readonly disputeId: unknown;
  readonly sellerOrderId: unknown;
  readonly bearer: unknown;
  readonly amountMinor?: unknown;
  readonly reasonCode: unknown;
};

/**
 * `commission-payouts.decide-dispute`: an admin decides who bears a lost chargeback on one seller
 * order, with a reason code (protected key). The platform bears it, or the seller repays up to its
 * unreversed share; audited with before and after.
 */
export class DecideDispute extends UseCase<Input, DisputeDecisionView, DisputeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.decide-dispute',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return decideDispute(this.deps, context, input);
  }
}
