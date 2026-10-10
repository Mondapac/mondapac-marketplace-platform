import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReleaseFailure, ReleaseResult } from '../../contracts/ordering-port';
import { releaseReservation, type ReleaseDependencies } from '../release-reservation-flow';
import { validationFailed } from '../source-use-case-support';

export interface ReleaseOwnReservationInput {
  readonly reservationId: string;
}

/**
 * `inventory.release-own-reservation` (inventory design 3.1, 6): the customer gives up their own
 * hold (cause `customer`). Rule `own-resources`, customer population: the reservation's holder
 * must be the actor's account, else the same `inventory.reservation.not-found` as an unknown id.
 */
export class ReleaseOwnReservation extends UseCase<
  ReleaseOwnReservationInput,
  ReleaseResult,
  ReleaseFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.release-own-reservation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReleaseDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ReleaseOwnReservationInput,
  ): Promise<Result<ReleaseResult, ReleaseFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    const id =
      typeof input?.reservationId === 'string' ? parseId<'Reservation'>(input.reservationId) : null;
    if (id === null || !id.ok) {
      return Promise.resolve(validationFailed([{ path: 'reservationId', code: 'format' }]));
    }
    return releaseReservation(this.deps, context, id.value, 'customer', actor.accountId);
  }
}
