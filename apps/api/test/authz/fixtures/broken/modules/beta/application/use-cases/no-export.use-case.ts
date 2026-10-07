import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

/** A use case the file does not export. */
class Hidden extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.no-export',
    rule: { kind: 'system' },
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}

export const HIDDEN_NAME = Hidden.name;
