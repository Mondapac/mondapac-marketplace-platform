import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { AvailabilitySystemQuery } from '../application/use-cases/availability-system.use-case';
import type { AvailabilityQuery } from '../application/use-cases/availability.use-case';
import type {
  AvailabilityMap,
  InventoryBatchTooLarge,
  InventoryFacade,
  InventoryValidationFailed,
  SellUnitKey,
} from '../contracts/inventory.facade';

export interface InventoryFacadeUseCases {
  readonly availability: AvailabilityQuery;
  readonly availabilitySystem: AvailabilitySystemQuery;
}

/** Each method passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class InventoryFacadeImplementation implements InventoryFacade {
  constructor(private readonly useCases: InventoryFacadeUseCases) {}

  availability(
    context: CallContext,
    keys: readonly SellUnitKey[],
  ): Promise<
    Result<AvailabilityMap, AccessDenied | InventoryValidationFailed | InventoryBatchTooLarge>
  > {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.availabilitySystem
        : this.useCases.availability;
    return useCase.execute(context, { keys });
  }
}
