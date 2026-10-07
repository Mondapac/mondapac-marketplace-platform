import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';
import { ALPHA_SELLERS_APPROVE } from '../../contracts';

export class ApproveSeller extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'alpha.approve-seller',
    rule: { kind: 'permissions', allOf: [ALPHA_SELLERS_APPROVE.key] },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
