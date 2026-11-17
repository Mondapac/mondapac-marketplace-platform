import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import { countGroupSegmentUses } from '../admin-read-flow';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * The customers key whose holder archives a manual customer group. promotions cannot brand
 * another module's key, so the literal is cast; `admin-facade-permission.contract.spec.ts` pins it
 * to `CUSTOMERS_GROUPS_MANAGE.key`.
 */
export const CUSTOMERS_GROUPS_MANAGE_KEY = 'customers.groups.manage' as PermissionKey;

/**
 * `promotions.count-group-segment-uses`: how many promotions that are live, paused or waiting
 * for approval name a manual customer group in their MANUAL_GROUP segment (customers management
 * phase 2b). customers asks it, through the registry it owns, when an admin archives the group;
 * the answer is a count only. Rule: `customers.groups.manage`, the key of the archive itself, and
 * the admin population.
 */
export class CountGroupSegmentUses extends UseCase<
  { readonly groupId: string },
  { readonly uses: number },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.count-group-segment-uses',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_GROUPS_MANAGE_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly groupId: string },
  ): Promise<Result<{ readonly uses: number }, PromotionsFailure>> {
    return countGroupSegmentUses(this.deps, context, input);
  }
}
