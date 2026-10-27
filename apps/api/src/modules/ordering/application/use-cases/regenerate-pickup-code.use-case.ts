import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OwnPickupCodeView } from '../../domain/order-views';
import type { OrderingDependencies } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';
import { regeneratePickupCode, type PickupFailure } from '../pickup-flow';

/**
 * The signed-in customer asks for a new pickup code for one pickup part of their own order: the
 * old code stops working and a lock from wrong tries is lifted. Answered to the buyer only.
 */
export class RegeneratePickupCode extends UseCase<
  { readonly orderId: unknown; readonly sellerId: unknown },
  OwnPickupCodeView,
  PickupFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.regenerate-pickup-code',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly orderId: unknown; readonly sellerId: unknown },
  ) {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' } as const);
    return regeneratePickupCode(this.deps, context, accountId, input);
  }
}
