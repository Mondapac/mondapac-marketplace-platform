import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LinkTokens } from '../ports/link-secrets';
import {
  SignInFlow,
  type LinkSignInDependencies,
  type SellerSignInDependencies,
  type SignedIn,
  type SignInClient,
  type SignInDependencies,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';
import { MAX_PASSWORD_BYTES } from './sign-in-customer.use-case';

export interface ConfirmSellerEmailInput {
  /** The token from the link's fragment, posted in the JSON body (identity design 6.6, I15). */
  readonly token: string;
  readonly password: string;
  readonly keepSignedIn: boolean;
  readonly client: SignInClient;
}

export type ConfirmSellerEmailOutput = SignedIn;

export type ConfirmSellerEmailFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | Exclude<SignInRefusal, { readonly code: 'email-verification-required' }>;

export type ConfirmSellerEmailDependencies = SignInDependencies &
  LinkSignInDependencies &
  SellerSignInDependencies & { readonly linkTokens: LinkTokens };

/**
 * Confirming a seller-side account's email (identity design 3.2, 6.3, 6.7 option B, 8.2; slices 3
 * and 5). Rule `anonymous`. The seller sign-in sequence with the link's token in place of the
 * typed email, as `ConfirmCustomerEmail`: the link is consumed only with the account's password,
 * and a correct password also signs in. Verifying a self-registered owner records
 * `identity.seller-registered.v1` (M4): from then on other modules see the seller, and the purge
 * no longer deletes it. A token that is malformed, unknown, used, expired, of another purpose,
 * population or Market answers `link.rejected`; it is never logged, stored or echoed.
 */
export class ConfirmSellerEmail extends UseCase<
  ConfirmSellerEmailInput,
  ConfirmSellerEmailOutput,
  ConfirmSellerEmailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-seller-email',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmSellerEmailDependencies,
  ) {
    super(gate);
    this.#flow = new SignInFlow('seller', deps, deps, deps);
  }

  protected async handle(
    context: CallContext,
    input: ConfirmSellerEmailInput,
  ): Promise<Result<ConfirmSellerEmailOutput, ConfirmSellerEmailFailure>> {
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const outcome = await this.#flow.run(
      context,
      { kind: 'link', tokenHash: this.deps.linkTokens.hashOf(input.token) },
      input.password,
      input.client,
      { keepSignedIn: input.keepSignedIn },
    );
    if (!outcome.ok && outcome.error.code === 'email-verification-required') {
      // The link variant verifies the email before that step.
      throw new Error('ConfirmSellerEmail: email-verification-required after a consumed link');
    }
    return outcome as Result<ConfirmSellerEmailOutput, ConfirmSellerEmailFailure>;
  }
}
