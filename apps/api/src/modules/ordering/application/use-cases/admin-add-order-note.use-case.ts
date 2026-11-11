import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_NOTE, ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  addAdminNote,
  type AdminNoteDependencies,
  type AdminNoteView,
  type NoteFailure,
} from '../admin-note-flow';

/**
 * Writes an internal note on an order (rule `permissions [ordering.order.view,
 * ordering.order.note]`: whoever writes a note can also read the order).
 */
export class AdminAddOrderNote extends UseCase<
  { readonly orderId: unknown; readonly body: unknown },
  AdminNoteView,
  NoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-add-order-note',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key, ORDERING_ORDER_NOTE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminNoteDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly orderId: unknown; readonly body: unknown },
  ) {
    return addAdminNote(this.deps, context, input);
  }
}
