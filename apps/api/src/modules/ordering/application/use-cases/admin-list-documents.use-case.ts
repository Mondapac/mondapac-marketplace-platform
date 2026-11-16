import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { DocumentListPage } from '../../domain/admin-document-list';
import {
  listDocuments,
  type AdminDocumentListDependencies,
  type DocumentListInput,
} from '../admin-document-list-flow';
import type { ReadFailure } from '../read-flow';

/**
 * The Market's order confirmations and credit notes, for the admin Invoices list (rule
 * `permissions [ordering.order.view]`: the same documents an admin can already open on the order
 * page).
 */
export class AdminListDocuments extends UseCase<DocumentListInput, DocumentListPage, ReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-documents',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminDocumentListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DocumentListInput) {
    return listDocuments(this.deps, context, input);
  }
}
