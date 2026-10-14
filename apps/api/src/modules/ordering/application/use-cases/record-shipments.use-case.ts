import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import {
  recordShipments,
  type FulfilmentFailure,
  type ShipmentRecording,
} from '../fulfilment-flow';

/**
 * Tells inventory that the lines of shipped seller orders have left. Rule `system`: only the
 * worker's job `ordering.record-shipments` calls it.
 */
export class RecordShipments extends UseCase<
  Record<string, never>,
  ShipmentRecording,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.record-shipments',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return recordShipments(this.deps, context);
  }
}
