import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SHIP_TO_RETENTION_VIEW } from '../../contracts/permissions';
import {
  viewShipToRetention,
  type ShipToRetentionDependencies,
  type ShipToRetentionFailure,
  type ShipToRetentionView,
} from '../ship-to-retention-flow';

export type { ShipToRetentionView };

/** The Market's ship-to retention setting (owner decision 2026-11-15; rule `permissions [ordering.ship-to-retention.view]`). */
export class AdminViewShipToRetention extends UseCase<
  Record<string, never>,
  ShipToRetentionView,
  ShipToRetentionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-view-ship-to-retention',
    rule: { kind: 'permissions', allOf: [ORDERING_SHIP_TO_RETENTION_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShipToRetentionDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewShipToRetention(this.deps, context);
  }
}
