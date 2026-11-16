import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW, CUSTOMERS_NOTES_WRITE } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import { addNote, type CustomerNoteView, type NoteFailure } from '../customer-notes-flow';

/**
 * `customers.admin-customer-note-add`: writes one internal note about a customer (sealed under the
 * customer's key, written once, never changed). Audited (id and length) and on the timeline. Rule:
 * `customers.customers.view` and `customers.customer-notes.write`.
 */
export class AdminCustomerNoteAdd extends UseCase<unknown, CustomerNoteView, NoteFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-note-add',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_NOTES_WRITE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerManagementDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CustomerNoteView, NoteFailure>> {
    return addNote(this.deps, context, input);
  }
}
