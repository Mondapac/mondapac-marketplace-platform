import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LinkTokens } from '../ports/link-secrets';
import {
  CustomerSignInFlow,
  type CustomerSignInDependencies,
  type LinkSignInDependencies,
  type SignedIn,
  type SignInClient,
  type SignInRefusal,
} from '../sign-in/customer-sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';
import { MAX_PASSWORD_BYTES } from './sign-in-customer.use-case';

export interface ConfirmCustomerEmailInput {
  /** The token from the link's fragment, posted in the JSON body (identity design 6.6, I15). */
  readonly token: string;
  readonly password: string;
  readonly client: SignInClient;
}

export type ConfirmCustomerEmailOutput = SignedIn;

export type ConfirmCustomerEmailFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | Exclude<SignInRefusal, { readonly code: 'email-verification-required' }>;

export interface ConfirmCustomerEmailDependencies
  extends CustomerSignInDependencies, LinkSignInDependencies {
  readonly linkTokens: LinkTokens;
}

/**
 * Confirming a customer's email (identity design 3.2, 6.3, 6.7 option B, 8.6 row 3; AC 16, AC 19;
 * slice 3). Rule `anonymous`. It is the sign-in sequence with the link's token in place of the
 * typed email, under the same throttling ({@link CustomerSignInFlow}): the link verifies only
 * with the account's password, is consumed only when the password is correct, and a correct
 * password also completes sign-in, so the customer types it once (Reza's proposal; accepted by
 * Hassan, 14.2). This is what lets an unverified account in after slice 2's
 * `email-verification-required` (Hassan I5).
 *
 * A token that is malformed, unknown, used, expired, of another purpose, population or Market
 * answers `link.rejected`: one answer for every cause (8.6 row 1). It is never logged, stored or
 * echoed; only its SHA-256 is compared, by index lookup and then in constant time.
 */
export class ConfirmCustomerEmail extends UseCase<
  ConfirmCustomerEmailInput,
  ConfirmCustomerEmailOutput,
  ConfirmCustomerEmailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-customer-email',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: CustomerSignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmCustomerEmailDependencies,
  ) {
    super(gate);
    this.#flow = new CustomerSignInFlow(deps, deps);
  }

  protected async handle(
    context: CallContext,
    input: ConfirmCustomerEmailInput,
  ): Promise<Result<ConfirmCustomerEmailOutput, ConfirmCustomerEmailFailure>> {
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const outcome = await this.#flow.run(
      context,
      { kind: 'link', tokenHash: this.deps.linkTokens.hashOf(input.token) },
      input.password,
      input.client,
    );
    if (!outcome.ok && outcome.error.code === 'email-verification-required') {
      // The link variant verifies the email before that step.
      throw new Error('ConfirmCustomerEmail: email-verification-required after a consumed link');
    }
    return outcome as Result<ConfirmCustomerEmailOutput, ConfirmCustomerEmailFailure>;
  }
}
