import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { CancelCommittedLine } from '../application/use-cases/cancel-committed-line.use-case';
import type { CommitReservation } from '../application/use-cases/commit-reservation.use-case';
import type { RecordShipment } from '../application/use-cases/record-shipment.use-case';
import type { ReleaseOwnReservation } from '../application/use-cases/release-own-reservation.use-case';
import type { ReleaseReservation } from '../application/use-cases/release-reservation.use-case';
import type { Reserve } from '../application/use-cases/reserve.use-case';
import type {
  CommitFailure,
  CommitRequest,
  InventoryOrderingPort,
  LineCommandFailure,
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
  readonly commitReservation: CommitReservation;
  readonly cancelCommittedLine: CancelCommittedLine;
  readonly recordShipment: RecordShipment;
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

  commitReservation(
    context: CallContext,
    request: CommitRequest,
  ): Promise<Result<ReleaseResult, CommitFailure>> {
    return this.useCases.commitReservation.execute(context, request);
  }

  cancelCommittedLine(
    context: CallContext,
    request: { readonly orderLineId: string },
  ): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>> {
    return this.useCases.cancelCommittedLine.execute(context, request);
  }

  recordShipment(
    context: CallContext,
    request: { readonly orderLineId: string },
  ): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>> {
    return this.useCases.recordShipment.execute(context, request);
  }
}
