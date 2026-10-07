import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { BETA_SELLERS_APPROVE } from '../../contracts';

/** A platform-scope key with a seller-state attribute that can never apply. */
export class PlatformSellerState extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.platform-seller-state',
    rule: { kind: 'permissions', allOf: [BETA_SELLERS_APPROVE.key] },
    whenSellerNotApproved: 'deny',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
