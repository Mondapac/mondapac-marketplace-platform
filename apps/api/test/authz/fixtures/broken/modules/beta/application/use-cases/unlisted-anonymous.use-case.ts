import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

/** A non-permission rule missing from the checked-in list. */
export class UnlistedAnonymous extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.unlisted-anonymous',
    rule: { kind: 'anonymous' },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
