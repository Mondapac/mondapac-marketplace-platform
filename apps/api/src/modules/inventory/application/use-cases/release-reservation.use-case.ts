import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ReleaseFailure,
  ReleaseResult,
  SystemReleaseCause,
} from '../../contracts/ordering-port';
import { releaseReservation, type ReleaseDependencies } from '../release-reservation-flow';
import { validationFailed } from '../source-use-case-support';

export interface ReleaseReservationInput {
  readonly reservationId: string;
  readonly cause: SystemReleaseCause;
}

const CAUSES: readonly string[] = ['cancelled', 'payment-failed'] satisfies SystemReleaseCause[];

/**
 * `inventory.release-reservation` (inventory design 3.1, 6, 7.2): `ordering` releases a hold
 * because the order was cancelled or payment failed. Rule `system`; the cause is one of those two.
 */
export class ReleaseReservation extends UseCase<
  ReleaseReservationInput,
  ReleaseResult,
  ReleaseFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.release-reservation',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReleaseDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ReleaseReservationInput,
  ): Promise<Result<ReleaseResult, ReleaseFailure>> {
    if (context.actor.kind !== 'system') return Promise.resolve(err({ code: 'access.denied' }));
    const fields: { path: string; code: string }[] = [];
    const id =
      typeof input?.reservationId === 'string' ? parseId<'Reservation'>(input.reservationId) : null;
    if (id === null || !id.ok) fields.push({ path: 'reservationId', code: 'format' });
    if (!CAUSES.includes(input?.cause)) fields.push({ path: 'cause', code: 'enum' });
    if (fields.length > 0 || id === null || !id.ok)
      return Promise.resolve(validationFailed(fields));
    return releaseReservation(this.deps, context, id.value, input.cause, null);
  }
}
