import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountRepository } from '../ports/account.repository';
import type { ExternalIdentityRepository } from '../ports/external-identity.repository';
import type { SignInProviderFlowSecrets, SignInProviders } from '../ports/sign-in-providers';
import {
  verifyProviderCallback,
  type ProviderCallbackFailure,
  type ProviderCallbackInput,
} from '../social/provider-callback';

export type LinkSignInProviderInput = ProviderCallbackInput;

export type LinkSignInProviderOutput = { readonly code: 'linked' };

export type LinkSignInProviderFailure =
  | ProviderCallbackFailure
  /** The provider's verified email is not the account's sign-in email. */
  | { readonly code: 'email.mismatch' }
  /**
   * The provider identity is connected to another account, or this account is connected to
   * another identity at the provider.
   */
  | { readonly code: 'identity.taken' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface LinkSignInProviderDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly externalIdentities: ExternalIdentityRepository;
  readonly signInProviders: SignInProviders;
  readonly flowSecrets: SignInProviderFlowSecrets;
  readonly clock: Clock;
}

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Connecting a sign-in provider to the signed-in customer's own account (rule `own-resources`):
 * the confirmation that follows a `link-required` answer. The customer proved the password by
 * signing in, and the provider proves the mailbox: after {@link verifyProviderCallback} (the
 * `link` intent), the provider's verified email must equal the account's sign-in email
 * (`email.mismatch` otherwise), so a provider account of someone else is never connected, even
 * through a forged flow. Connecting the identity the account already holds answers `linked`
 * again; another identity on either side answers `identity.taken`. Customers only.
 */
export class LinkSignInProvider extends UseCase<
  LinkSignInProviderInput,
  LinkSignInProviderOutput,
  LinkSignInProviderFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.link-sign-in-provider',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('LinkSignInProvider');

  constructor(
    gate: UseCaseGate,
    private readonly deps: LinkSignInProviderDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: LinkSignInProviderInput,
  ): Promise<Result<LinkSignInProviderOutput, LinkSignInProviderFailure>> {
    const { market, actor } = context;
    // The gate admits only an authenticated actor under own-resources; customers only.
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' });
    }
    const verified = await verifyProviderCallback(
      market,
      'link',
      input,
      this.deps.signInProviders,
      this.deps.flowSecrets,
    );
    if (!verified.ok) return err(verified.error);
    const person = verified.value;
    const { unitOfWork, accounts, externalIdentities } = this.deps;
    try {
      const run = await unitOfWork.run(
        market,
        async (): Promise<Result<LinkSignInProviderOutput, LinkSignInProviderFailure>> => {
          const account = await accounts.findById(market, actor.accountId);
          if (account === null) return err({ code: 'access.denied' });
          if (account.state.email.normalized !== person.email.normalized) {
            return err({ code: 'email.mismatch' });
          }
          const known = await externalIdentities.findBySubject(
            market,
            input.provider,
            person.subject,
          );
          if (known !== null) {
            return known.accountId === account.state.id
              ? ok({ code: 'linked' })
              : err({ code: 'identity.taken' });
          }
          const added = await externalIdentities.add(market, {
            accountId: account.state.id,
            provider: input.provider,
            subject: person.subject,
            createdAt: this.deps.clock.now(),
          });
          return added.ok ? ok({ code: 'linked' }) : err({ code: 'identity.taken' });
        },
      );
      return run;
    } catch {
      this.#logger.warn({
        msg: 'identity.link-sign-in-provider.unit-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(UNAVAILABLE);
    }
  }
}
