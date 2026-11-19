import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SHIP_TO_RETENTION_MANAGE } from '../../contracts/permissions';
import {
  setShipToRetention,
  type ShipToRetentionDependencies,
  type ShipToRetentionFailure,
  type ShipToRetentionView,
} from '../ship-to-retention-flow';

interface Input {
  readonly enabled: unknown;
  readonly months: unknown;
  readonly expectedVersion: unknown;
}

/**
 * Sets the Market's ship-to retention (owner decision 2026-11-15; rule `permissions
 * [ordering.ship-to-retention.manage]`, a protected key) after a fresh two-step code
 * (`ordering.ship-to-retention.change`), spent in the same unit.
 */
export class AdminSetShipToRetention extends UseCase<
  Input,
  ShipToRetentionView,
  ShipToRetentionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-set-ship-to-retention',
    rule: { kind: 'permissions', allOf: [ORDERING_SHIP_TO_RETENTION_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShipToRetentionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setShipToRetention(this.deps, context, input);
  }
}
