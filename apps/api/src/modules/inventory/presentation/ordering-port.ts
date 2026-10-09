import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ReleaseOwnReservation } from '../application/use-cases/release-own-reservation.use-case';
import type { ReleaseReservation } from '../application/use-cases/release-reservation.use-case';
import type { Reserve } from '../application/use-cases/reserve.use-case';
import type {
  InventoryOrderingPort,
  ReleaseFailure,
  ReleaseResult,
  ReserveFailure,
  ReserveRequest,
  ReserveResult,
  SystemReleaseCause,
} from '../contracts/ordering-port';

export interface OrderingPortUseCases {
  readonly reserve: Reserve;
  readonly releaseReservation: ReleaseReservation;
  readonly releaseOwnReservation: ReleaseOwnReservation;
}

/** Each method passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class InventoryOrderingPortImplementation implements InventoryOrderingPort {
  constructor(private readonly useCases: OrderingPortUseCases) {}

  reserve(
    context: CallContext,
    request: ReserveRequest,
  ): Promise<Result<ReserveResult, ReserveFailure>> {
    return this.useCases.reserve.execute(context, request);
  }

  releaseReservation(
    context: CallContext,
    request: { readonly reservationId: string; readonly cause: SystemReleaseCause },
  ): Promise<Result<ReleaseResult, ReleaseFailure>> {
    return this.useCases.releaseReservation.execute(context, request);
  }

  releaseOwnReservation(
    context: CallContext,
    request: { readonly reservationId: string },
  ): Promise<Result<ReleaseResult, ReleaseFailure>> {
    return this.useCases.releaseOwnReservation.execute(context, request);
  }
}
