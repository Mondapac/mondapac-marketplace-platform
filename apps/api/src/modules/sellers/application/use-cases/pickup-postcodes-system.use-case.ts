import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  pickupPostcodesFor,
  type PickupPostcodesDependencies,
  type PickupPostcodesFailure,
  type PickupPostcodesInput,
} from './pickup-postcodes.use-case';

/**
 * `pickupPostcodes` for jobs and event handlers (dashboards v2: shipping derives a pickup's region
 * for reporting under the system actor): rule `system`, the same answer.
 */
export class PickupPostcodesSystem extends UseCase<
  PickupPostcodesInput,
  ReadonlyMap<Id<'Seller'>, string>,
  PickupPostcodesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.pickup-postcodes-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PickupPostcodesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: PickupPostcodesInput,
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, PickupPostcodesFailure>> {
    return pickupPostcodesFor(this.deps, context, input);
  }
}
