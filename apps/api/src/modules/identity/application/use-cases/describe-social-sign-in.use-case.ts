import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LinkTargets } from '../ports/link-secrets';
import type { SignInProviderName, SignInProviders } from '../ports/sign-in-providers';

export interface DescribeSocialSignInOutput {
  /** The providers configured for the Market; empty hides every provider button. */
  readonly providers: readonly SignInProviderName[];
  /**
   * The storefront page a provider callback sends the browser back to (the Market's customer
   * sign-in page), or null when the Market configures none: then no flow can end.
   */
  readonly returnPage: string | null;
}

export interface DescribeSocialSignInDependencies {
  readonly signInProviders: SignInProviders;
  readonly targets: LinkTargets;
}

/**
 * What the storefront needs to offer social sign-in (rule `anonymous`): the providers configured
 * for the Market and the page every callback returns to. Reads configuration only.
 */
export class DescribeSocialSignIn extends UseCase<
  Record<string, never>,
  DescribeSocialSignInOutput,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.describe-social-sign-in',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescribeSocialSignInDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<DescribeSocialSignInOutput, never>> {
    const returnPage = this.deps.targets.target(context.market, 'customer', 'sign-in');
    const providers =
      returnPage === null ? [] : this.deps.signInProviders.configured(context.market);
    return Promise.resolve(ok({ providers, returnPage }));
  }
}
