import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import {
  syncPayoutSchedules,
  type ScheduleSyncFailure,
  type ScheduleSyncSummary,
} from '../payout-schedule-flow';

/**
 * Brings the Stripe payout schedule of each connected account in line with the bank-change
 * waiting period. Rule `system`: only the worker's job calls it.
 */
export class SyncPayoutSchedules extends UseCase<
  Record<string, never>,
  ScheduleSyncSummary,
  ScheduleSyncFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.sync-payout-schedules',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return syncPayoutSchedules(this.deps, context);
  }
}
