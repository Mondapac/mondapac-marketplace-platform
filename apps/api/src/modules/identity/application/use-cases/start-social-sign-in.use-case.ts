import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LinkTargets } from '../ports/link-secrets';
import type {
  SignInProviderFlowSecrets,
  SignInProviderIntent,
  SignInProviderName,
  SignInProviders,
} from '../ports/sign-in-providers';

export interface StartSocialSignInInput {
  readonly provider: SignInProviderName;
  readonly intent: SignInProviderIntent;
}

export interface StartSocialSignInOutput {
  /** Where the browser goes next: the provider's consent page. */
  readonly authorizationUrl: string;
  /** The flow secret: the controller sets it in the flow cookie only, never a body or a log. */
  readonly flowSecret: string;
}

export type StartSocialSignInFailure = { readonly code: 'sign-in-provider.not-configured' };

export interface StartSocialSignInDependencies {
  readonly signInProviders: SignInProviders;
  readonly flowSecrets: SignInProviderFlowSecrets;
  readonly targets: LinkTargets;
}

/**
 * The first step of social sign-in (rule `anonymous`; the link intent is checked at the callback,
 * against the session that comes back with it): a new flow secret, and the provider's
 * authorisation URL carrying the state, the nonce and the PKCE challenge derived from it. A
 * provider that is not configured for the Market, or a Market without a customer sign-in page to
 * return to, answers `sign-in-provider.not-configured`. Nothing is stored.
 */
export class StartSocialSignIn extends UseCase<
  StartSocialSignInInput,
  StartSocialSignInOutput,
  StartSocialSignInFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-social-sign-in',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartSocialSignInDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: StartSocialSignInInput,
  ): Promise<Result<StartSocialSignInOutput, StartSocialSignInFailure>> {
    const { market } = context;
    const { signInProviders, flowSecrets, targets } = this.deps;
    const notConfigured = err({ code: 'sign-in-provider.not-configured' as const });
    if (targets.target(market, 'customer', 'sign-in') === null)
      return Promise.resolve(notConfigured);
    const flowSecret = flowSecrets.issue();
    const flow = flowSecrets.derive(flowSecret, market, input.provider, input.intent);
    if (flow === null) throw new Error('StartSocialSignIn: a new flow secret does not derive');
    const authorizationUrl = signInProviders.authorizationUrl(market, input.provider, flow);
    if (authorizationUrl === null) return Promise.resolve(notConfigured);
    return Promise.resolve(ok({ authorizationUrl, flowSecret }));
  }
}

// The names a controller validates a request against (entry points import use cases only).
export {
  SIGN_IN_PROVIDERS,
  SIGN_IN_PROVIDER_INTENTS,
  type SignInProviderIntent,
  type SignInProviderName,
} from '../ports/sign-in-providers';
