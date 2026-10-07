import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { BETA_ORDERS_VIEW } from '../../contracts';

/** A seller-scope key without the seller-state attribute. */
export class MissingSellerState extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.missing-seller-state',
    rule: { kind: 'permissions', allOf: [BETA_ORDERS_VIEW.key] },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
