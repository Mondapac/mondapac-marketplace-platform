import {
  ok,
  UseCase,
  type AccessDeclaration,
  type CallContext,
  type Result,
} from '../../../../../platform';

/** Declares the name of `sign-out.use-case.ts`: not its file stem, and a duplicate. */
export class WrongName extends UseCase<void, string> {
  static override readonly access: AccessDeclaration = {
    name: 'beta.sign-out',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  protected handle(context: CallContext): Promise<Result<string, never>> {
    return Promise.resolve(ok(context.market.marketId));
  }
}
