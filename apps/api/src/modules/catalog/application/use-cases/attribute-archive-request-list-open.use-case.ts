import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { closedInput, editorAccountOf } from '../attributes/attribute-editor';
import {
  openRequestViews,
  type AttributeRelaxationListOpenFailure,
  type OpenRelaxationView,
  type OpenRequestListDependencies,
} from './attribute-relaxation-list-open.use-case';

/**
 * `attribute-archive-requests.list-open` (attributes A8): the Market's open requests to archive a
 * `material` attribute that are still in time, oldest first, with what the reader may do (confirm
 * another administrator's request, withdraw their own). Rule: the key
 * `catalog.attribute.restructure` (protected), the admin population, never in an acting-as
 * session, so the list shows what that key can decide.
 */
export class AttributeArchiveRequestListOpen extends UseCase<
  Record<string, unknown>,
  { readonly requests: readonly OpenRelaxationView[] },
  AttributeRelaxationListOpenFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-archive-request-list-open',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_RESTRUCTURE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OpenRequestListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<
    Result<{ readonly requests: readonly OpenRelaxationView[] }, AttributeRelaxationListOpenFailure>
  > {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, []);
    if (!body.ok) return body;
    const requests = await openRequestViews(
      this.deps,
      context,
      accountId,
      (kind) => kind === 'archive',
    );
    if (!requests.ok) return requests;
    return ok({ requests: requests.value });
  }
}
