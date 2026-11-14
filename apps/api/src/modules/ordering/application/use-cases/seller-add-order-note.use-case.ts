import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  ORDERING_SELLER_ORDER_NOTE,
  ORDERING_SELLER_ORDER_VIEW,
} from '../../contracts/permissions';
import {
  addSellerNote,
  type SellerNoteDependencies,
  type SellerNoteFailure,
  type SellerNoteView,
} from '../seller-note-flow';

/**
 * Writes a note on one of the shop's own paid seller orders (rule `permissions
 * [ordering.seller-order.view, ordering.seller-order.note]`: whoever writes a note can also read
 * the order). Refused in an acting-as session.
 */
export class SellerAddOrderNote extends UseCase<
  { readonly sellerOrderId: unknown; readonly body: unknown },
  SellerNoteView,
  SellerNoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-add-order-note',
    rule: {
      kind: 'permissions',
      allOf: [ORDERING_SELLER_ORDER_VIEW.key, ORDERING_SELLER_ORDER_NOTE.key],
    },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerNoteDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellerOrderId: unknown; readonly body: unknown },
  ) {
    return addSellerNote(this.deps, context, input);
  }
}
