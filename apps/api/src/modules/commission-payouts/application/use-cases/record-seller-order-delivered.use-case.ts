import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerOrderDelivered } from '../../contracts/commission-payouts.facade';
import { recordSellerOrderDelivered, type AnchorFailure } from '../anchor-flow';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';

/**
 * `commission-payouts.record-seller-order-delivered`: freezes the eligibility anchor of a delivered
 * seller order (delivery instant + the hold days of the effective payout terms). Rule `system`:
 * only ordering calls it, through the facade.
 */
export class RecordSellerOrderDelivered extends UseCase<
  SellerOrderDelivered,
  'anchored' | 'already-anchored',
  AnchorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.record-seller-order-delivered',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerOrderDelivered) {
    return recordSellerOrderDelivered(this.deps, context, input);
  }
}
