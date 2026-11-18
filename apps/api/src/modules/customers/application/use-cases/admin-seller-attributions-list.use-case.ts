import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  listAttributions,
  parseAttributionPage,
  type AttributionListOutput,
  type InvitationDependencies,
  type InvitationFailure,
} from '../seller-invitations-flow';

/**
 * `customers.admin-seller-attributions-list`: the admin's list of customers attributed to a seller
 * through an invite link (customers management phase 4a), a super list. Views suspicious (rejected
 * or flagged; the default), all, active and rejected; search by the start of the sign-in address;
 * filters seller, status, reject reason, flag and attribution days; newest first or oldest first;
 * a page number with the total, or a cursor. Rule `customers.customers.view`; admin only, not in a
 * Login as Seller session.
 */
export class AdminSellerAttributionsList extends UseCase<
  unknown,
  AttributionListOutput,
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-seller-attributions-list',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<AttributionListOutput, InvitationFailure>> {
    const request = parseAttributionPage(input);
    if (!request.ok) return request;
    return listAttributions(this.deps, context, request.value);
  }
}
