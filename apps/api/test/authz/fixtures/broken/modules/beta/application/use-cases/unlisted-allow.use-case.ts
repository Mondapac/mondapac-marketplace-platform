import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { BETA_ORDERS_VIEW } from '../../contracts';

/** An `allow` missing from the checked-in list. */
export class UnlistedAllow extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.unlisted-allow',
    rule: { kind: 'permissions', allOf: [BETA_ORDERS_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
