import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  listAdminNotes,
  type AdminNoteDependencies,
  type AdminNoteView,
  type NoteFailure,
} from '../admin-note-flow';

export type { AdminNoteView };

/** An order's internal notes, newest first (rule `permissions [ordering.order.view]`). */
export class AdminListOrderNotes extends UseCase<
  { readonly orderId: unknown },
  readonly AdminNoteView[],
  NoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-order-notes',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminNoteDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly orderId: unknown }) {
    return listAdminNotes(this.deps, context, input);
  }
}
