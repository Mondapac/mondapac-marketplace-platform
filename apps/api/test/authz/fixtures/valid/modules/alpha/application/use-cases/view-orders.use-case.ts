import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { ALPHA_ORDERS_VIEW } from '../../contracts';

export class ViewOrders extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'alpha.view-orders',
    rule: { kind: 'permissions', allOf: [ALPHA_ORDERS_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
