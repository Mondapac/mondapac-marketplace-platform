import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  listSellerNotes,
  type SellerNoteDependencies,
  type SellerNoteFailure,
  type SellerNoteView,
} from '../seller-note-flow';

export type { SellerNoteView };

/**
 * The notes on one of the shop's own paid seller orders, newest first (rule `permissions
 * [ordering.seller-order.view]`). An acting-as session may read them, as it reads the order.
 */
export class SellerListOrderNotes extends UseCase<
  { readonly sellerOrderId: unknown },
  readonly SellerNoteView[],
  SellerNoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-list-order-notes',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerNoteDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return listSellerNotes(this.deps, context, input);
  }
}
