import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

export class SignOut extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'alpha.sign-out',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
