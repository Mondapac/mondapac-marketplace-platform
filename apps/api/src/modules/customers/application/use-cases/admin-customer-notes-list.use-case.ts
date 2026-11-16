import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import { listNotes, type CustomerNotesPage, type NoteFailure } from '../customer-notes-flow';

/**
 * `customers.admin-customer-notes-list`: a customer's internal admin notes, newest first, a page at
 * a time. The text is opened from the customer's key; a destroyed key shows a note without text.
 * Rule: `customers.customers.view` and the admin population. Personal data, never logged.
 */
export class AdminCustomerNotesList extends UseCase<unknown, CustomerNotesPage, NoteFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-notes-list',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
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
  ): Promise<Result<CustomerNotesPage, NoteFailure>> {
    return listNotes(this.deps, context, input);
  }
}
