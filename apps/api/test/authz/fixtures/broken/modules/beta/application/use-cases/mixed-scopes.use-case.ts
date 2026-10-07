import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { BETA_ORDERS_VIEW, BETA_SELLERS_APPROVE } from '../../contracts';

/** One seller key and one platform key in one rule. */
export class MixedScopes extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.mixed-scopes',
    rule: { kind: 'permissions', allOf: [BETA_ORDERS_VIEW.key, BETA_SELLERS_APPROVE.key] },
    whenSellerNotApproved: 'deny',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
