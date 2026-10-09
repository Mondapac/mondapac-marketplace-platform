import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AvailabilityMap } from '../../contracts/inventory.facade';
import {
  readAvailability,
  type AvailabilityDependencies,
  type AvailabilityFailure,
  type AvailabilityInput,
} from '../availability/read-availability';

/** `availability` for event handlers and jobs: rule `system`. */
export class AvailabilitySystemQuery extends UseCase<
  AvailabilityInput,
  AvailabilityMap,
  AvailabilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.availability-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AvailabilityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AvailabilityInput) {
    return readAvailability(this.deps, context, input);
  }
}
