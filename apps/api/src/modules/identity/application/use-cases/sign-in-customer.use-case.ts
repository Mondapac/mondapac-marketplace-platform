import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import {
  SELLER_ONLY_REFUSALS,
  SignInFlow,
  type SellerOnlyRefusal,
  type SignInDependencies,
  type SignedIn,
  type SignInClient,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export type { SignInClient } from '../sign-in/sign-in-flow';

/** The raw password is at most this many bytes, so a request cannot buy an expensive hash (6.5). */
export const MAX_PASSWORD_BYTES = 1024;

export interface SignInCustomerInput {
  readonly email: string;
  readonly password: string;
  readonly client: SignInClient;
}

/**
 * A new session. The token goes into the cookie only; the controller never puts it in a body
 * or a log.
 */
export type SignInCustomerOutput = SignedIn;

export type SignInCustomerFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | Exclude<SignInRefusal, { readonly code: 'link.rejected' } | SellerOnlyRefusal>;

export type SignInCustomerDependencies = SignInDependencies;

/**
 * Customer sign-in (identity design 3.5, 6.3, 6.8, 10.2; CUS-02; slice 2). Rule `anonymous`: the
 * gate passes the Market's anonymous actor whoever calls (HF9). After the request's own checks,
 * the steps of 6.3 run in {@link SignInFlow} with the typed email: the reservation unit,
 * the hash outside any unit, the closing unit. An unverified email answers
 * `email-verification-required` after a correct password (Hassan I5): the only way in for it is
 * the verification link (`ConfirmCustomerEmail`, slice 3).
 *
 * Refusals are `ok` outcomes of their units, so the counters and the record commit (PN1). An
 * unknown address, a wrong password, and another population or Market all answer
 * `credentials.invalid` (AC 1, AC 3).
 */
export class SignInCustomer extends UseCase<
  SignInCustomerInput,
  SignInCustomerOutput,
  SignInCustomerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-customer',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(gate: UseCaseGate, deps: SignInCustomerDependencies) {
    super(gate);
    this.#flow = new SignInFlow('customer', deps);
  }

  protected async handle(
    context: CallContext,
    input: SignInCustomerInput,
  ): Promise<Result<SignInCustomerOutput, SignInCustomerFailure>> {
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const outcome = await this.#flow.run(
      context,
      { kind: 'email', email: email.value },
      input.password,
      input.client,
    );
    if (
      !outcome.ok &&
      (outcome.error.code === 'link.rejected' || SELLER_ONLY_REFUSALS.has(outcome.error.code))
    ) {
      // The email variant never reads a link, and a customer has no membership or seller.
      throw new Error(`SignInCustomer: ${outcome.error.code} for a customer by email`);
    }
    return outcome as Result<SignInCustomerOutput, SignInCustomerFailure>;
  }
}
