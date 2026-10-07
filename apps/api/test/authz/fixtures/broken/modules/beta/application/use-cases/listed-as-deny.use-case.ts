import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

/** Says `allow` in code while the list records `deny`. */
export class ListedAsDeny extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.listed-as-deny',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
