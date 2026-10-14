import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LineCommandFailure } from '../../contracts/ordering-port';
import { runLineCommand, type LineCommandDependencies } from '../line-command-flow';
import { validationFailed } from '../source-use-case-support';

export interface RecordShipmentInput {
  readonly orderLineId: string;
}

/**
 * `inventory.record-shipment` (inventory design 3.2, 7.2, 10): `ordering` reports a committed line shipped: the source's on-hand goes down and a `shipment` movement is written. Rule `system`; keyed by the order line, so
 * a repeat succeeds and writes nothing.
 */
export class RecordShipment extends UseCase<
  RecordShipmentInput,
  { readonly orderLineId: string },
  LineCommandFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.record-shipment',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LineCommandDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RecordShipmentInput,
  ): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>> {
    if (context.actor.kind !== 'system') return Promise.resolve(err({ code: 'access.denied' }));
    const id = typeof input?.orderLineId === 'string' ? parseId(input.orderLineId) : null;
    if (id === null || !id.ok) {
      return Promise.resolve(validationFailed([{ path: 'orderLineId', code: 'format' }]));
    }
    return runLineCommand(this.deps, context, 'ship', id.value);
  }
}
