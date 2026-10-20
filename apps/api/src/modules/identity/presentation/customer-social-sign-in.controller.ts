import { Controller, Get, HttpCode, Logger, Param, Query, Req, Res } from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext, MarketId } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { readCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { DescribeSocialSignIn } from '../application/use-cases/describe-social-sign-in.use-case';
import { LinkSignInProvider } from '../application/use-cases/link-sign-in-provider.use-case';
import { SignInWithProvider } from '../application/use-cases/sign-in-with-provider.use-case';
import {
  SIGN_IN_PROVIDER_INTENTS,
  SIGN_IN_PROVIDERS,
  StartSocialSignIn,
  type SignInProviderIntent,
  type SignInProviderName,
} from '../application/use-cases/start-social-sign-in.use-case';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import { SignInProvidersAnswer } from './customer-social-sign-in.dto';

/** How long a started flow may take before its cookie is gone (the provider's consent page). */
const FLOW_COOKIE_SECONDS = 10 * 60;
/** The flow cookie's value: the intent's letter, then the 43-character flow secret. */
const FLOW_COOKIE_VALUE = /^([sl])([A-Za-z0-9_-]{43})$/;
const INTENT_LETTER: Readonly<Record<SignInProviderIntent, 's' | 'l'>> = Object.freeze({
  'sign-in': 's',
  link: 'l',
});

/**
 * The flow cookie (social sign-in): `__Host-`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax` so
 * it comes back on the provider's top-level redirect to the callback, ten minutes at most, and
 * cleared by every callback. Its name ends with the Market code, like the session cookie.
 */
const flowCookieName = (marketId: MarketId): string => `__Host-social-customer-${marketId}`;
const flowCookie = (marketId: MarketId, value: string, maxAge: number): string =>
  `${flowCookieName(marketId)}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

/**
 * Where a callback sends the browser back: the storefront's customer sign-in page with
 * `?social=<outcome>`. Every outcome but `signed-in`, `signed-up` and `linked` is a refusal the
 * page explains; `link-required` asks the customer to sign in with the password, then connect.
 */
export const SOCIAL_OUTCOMES = [
  'signed-in',
  'signed-up',
  'linked',
  'link-required',
  'sign-in-required',
  'email-unverified',
  'email-mismatch',
  'already-linked',
  'account-disabled',
  'cancelled',
  'expired',
  'not-configured',
  'failed',
] as const;
type SocialOutcome = (typeof SOCIAL_OUTCOMES)[number];

/** A refusal code of the callback's use cases as the outcome the storefront shows. */
const OUTCOME_OF: Readonly<Record<string, SocialOutcome>> = Object.freeze({
  'link-required': 'link-required',
  'email.unverified': 'email-unverified',
  'email.mismatch': 'email-mismatch',
  'identity.taken': 'already-linked',
  'account.disabled': 'account-disabled',
  'access.unauthenticated': 'sign-in-required',
  'sign-in-provider.not-configured': 'not-configured',
});

const queryString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Social sign-in for customers over HTTP: thin adapters over four use cases. The browser
 * navigates to every route (no JSON body, no CSRF header), so the unsafe-method checks never
 * apply; what protects the flow is the state bound to the flow cookie, PKCE and the ID token's
 * nonce (see `verifyProviderCallback`).
 *
 * - `GET social/providers`: the providers configured for the Market, for the storefront's
 *   buttons (empty: no button).
 * - `GET social/:provider/start?intent=sign-in|link`: sets the flow cookie and redirects to the
 *   provider. A provider not configured answers 404 `sign-in-provider.not-configured`.
 * - `GET social/:provider/callback`: the provider's redirect. Reads the customer session (for
 *   the `link` intent), clears the flow cookie, and redirects to the storefront's sign-in page
 *   with the outcome; a sign-in also sets the session cookie, as the password sign-in does.
 *
 * Every route logs its outcome with the correlation id; never the code, the state, the flow
 * secret, a token, the email or the provider's subject.
 */
@ApiTags('identity')
@RoutePopulation('customer')
@Controller('identity/customer/social')
export class CustomerSocialSignInController {
  readonly #logger = new Logger('CustomerSocialSignInController');

  constructor(
    private readonly describeSocialSignIn: DescribeSocialSignIn,
    private readonly startSocialSignIn: StartSocialSignIn,
    private readonly signInWithProvider: SignInWithProvider,
    private readonly linkSignInProvider: LinkSignInProvider,
  ) {}

  @Get('providers')
  @ApiOperation({
    summary: 'The sign-in providers configured for the Market',
    description:
      'Empty until the server holds a provider’s client and the Market names its redirect URI.',
  })
  @ApiOkResponse({ type: SignInProvidersAnswer })
  async providers(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignInProvidersAnswer> {
    const described = await this.describeSocialSignIn.execute(context, {});
    if (!described.ok) throw fail(503, 'access.unavailable');
    response.setHeader('Cache-Control', 'no-store');
    return { providers: [...described.value.providers] };
  }

  @Get(':provider/start')
  @HttpCode(302)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Start signing in with a provider',
    description:
      'Sets the flow cookie and redirects to the provider. intent=link connects the provider to ' +
      'the signed-in account at the callback (after a link-required answer).',
  })
  @ApiParam({ name: 'provider', enum: SIGN_IN_PROVIDERS })
  @ApiQuery({ name: 'intent', enum: SIGN_IN_PROVIDER_INTENTS, required: false })
  @ApiFoundResponse({ description: 'To the provider’s consent page' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'sign-in-provider.not-configured' })
  async start(
    @Call() context: CallContext,
    @Param('provider') provider: string,
    @Query('intent') intentParam: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const intent = intentParam === undefined ? 'sign-in' : queryString(intentParam);
    if (!isProvider(provider) || !isIntent(intent)) {
      this.log('identity.customer-social-start', context, 'sign-in-provider.not-configured');
      throw fail(404, 'sign-in-provider.not-configured');
    }
    const started = await this.startSocialSignIn.execute(context, { provider, intent });
    const code = started.ok ? 'started' : started.error.code;
    this.log('identity.customer-social-start', context, code);
    if (!started.ok) {
      throw started.error.code === 'sign-in-provider.not-configured'
        ? fail(404, started.error.code)
        : fail(503, 'access.unavailable');
    }
    const { marketId } = context.market;
    response.setHeader(
      'Set-Cookie',
      flowCookie(
        marketId,
        `${INTENT_LETTER[intent]}${started.value.flowSecret}`,
        FLOW_COOKIE_SECONDS,
      ),
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(302, started.value.authorizationUrl);
  }

  @Get(':provider/callback')
  @HttpCode(302)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'The provider’s redirect back',
    description:
      'Redirects to the storefront sign-in page with ?social=<outcome>; a sign-in sets the ' +
      'session cookie. Never answers JSON except when the Market has no page to return to.',
  })
  @ApiParam({ name: 'provider', enum: SIGN_IN_PROVIDERS })
  @ApiFoundResponse({ description: 'To the storefront sign-in page, with the outcome' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'sign-in-provider.not-configured' })
  async callback(
    @Call() context: CallContext,
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const described = await this.describeSocialSignIn.execute(context, {});
    const returnPage = described.ok ? described.value.returnPage : null;
    if (returnPage === null) {
      this.log('identity.customer-social-callback', context, 'sign-in-provider.not-configured');
      throw fail(404, 'sign-in-provider.not-configured');
    }
    const { marketId } = context.market;
    const cookies = [flowCookie(marketId, '', 0)];
    const finish = (outcome: SocialOutcome, reason: string): void => {
      this.log('identity.customer-social-callback', context, reason);
      const target = new URL(returnPage);
      target.searchParams.set('social', outcome);
      response.setHeader('Set-Cookie', cookies);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.redirect(302, target.toString());
    };

    const flowRead = readCookie(request.headers.cookie, flowCookieName(marketId));
    const flowMatch = flowRead.kind === 'one' ? FLOW_COOKIE_VALUE.exec(flowRead.value) : null;
    if (!isProvider(provider)) return finish('not-configured', 'sign-in-provider.not-configured');
    if (queryString(query.error) !== null) return finish('cancelled', 'provider.cancelled');
    if (flowMatch === null) return finish('expired', 'flow.expired');
    const code = queryString(query.code);
    const state = queryString(query.state);
    if (code === null || state === null) return finish('failed', 'flow.rejected');
    const input = { provider, code, state, flowSecret: flowMatch[2]! };

    if (flowMatch[1] === INTENT_LETTER.link) {
      const linked = await this.linkSignInProvider.execute(context, input);
      if (linked.ok) return finish('linked', 'linked');
      return finish(OUTCOME_OF[linked.error.code] ?? 'failed', linked.error.code);
    }

    // The resolved client address (ADR-0037): forwarded headers are never trusted (Hassan I4).
    const origin = clientOriginOf(clientAddressFrom(request));
    const address = clientAddressOf(clientAddressFrom(request));
    if (origin === null || address === null) return finish('failed', 'access.unavailable');
    const signedIn = await this.signInWithProvider.execute(context, {
      ...input,
      client: { origin, address },
    });
    if (!signedIn.ok) {
      return finish(OUTCOME_OF[signedIn.error.code] ?? 'failed', signedIn.error.code);
    }
    const { token, absoluteLifetimeSeconds, created } = signedIn.value;
    cookies.push(sessionCookie('customer', marketId, token, absoluteLifetimeSeconds));
    return finish(created ? 'signed-up' : 'signed-in', created ? 'signed-up' : 'signed-in');
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

const isProvider = (value: string | null): value is SignInProviderName =>
  (SIGN_IN_PROVIDERS as readonly (string | null)[]).includes(value);

const isIntent = (value: string | null): value is SignInProviderIntent =>
  (SIGN_IN_PROVIDER_INTENTS as readonly (string | null)[]).includes(value);
