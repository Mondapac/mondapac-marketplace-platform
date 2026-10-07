import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

/** Two use cases in one file. */
export class TwoExportsFirst extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.two-exports',
    rule: { kind: 'system' },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}

export class TwoExportsSecond extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.two-exports',
    rule: { kind: 'system' },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
