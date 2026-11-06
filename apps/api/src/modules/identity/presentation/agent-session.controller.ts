import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER, csrfTokenFor } from '../../../platform/call-context/csrf';
import { clearedSessionCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import { SessionCsrfToken } from '../../../platform/call-context/session-csrf-token';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { AcceptAgentInvitation } from '../application/use-cases/accept-agent-invitation.use-case';
import { CompleteAgentSignIn } from '../application/use-cases/complete-agent-sign-in.use-case';
import { DescribeAgentSession } from '../application/use-cases/describe-agent-session.use-case';
import { SignInAgent } from '../application/use-cases/sign-in-agent.use-case';
import { SignOutAgent } from '../application/use-cases/sign-out-agent.use-case';
import { StartAgentInvitationAcceptance } from '../application/use-cases/start-agent-invitation-acceptance.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import {
  AdminInvitationEnrolmentReady,
  AdminInvitationTokenRequest,
  AdminSecondFactorRequest,
  AdminSignedIn,
  AdminSignInRequest,
  RecoveryCodesShown,
} from './admin.dto';
import { AgentAcceptInvitationRequest, AgentSessionSummary, AgentSignInStep } from './agent.dto';
import { CustomerSignedOut } from './customer-session.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The agent population's routes (ADR-0045 decisions 2 to 4, 6): sign-in, its code step, sign-out,
 * the session summary, and the two steps of accepting an invitation. Thin adapters: the
 * `CallContext` comes from `@Call()`, each route calls one use case through its gate. JSON only.
 *
 * - `POST sign-in` (anonymous): a correct password never opens a session; it answers a challenge.
 * - `POST second-factor` (anonymous): the challenge token and a code; on success the
 *   `__Host-session-agent-<MARKET>` cookie (`SameSite=Strict`, no `Max-Age`) and the CSRF token.
 * - `POST invitation/enrolment` and `POST invitation/accept` (anonymous): accepting is one
 *   request carrying the link token, the handover code, the password and the first code; it opens
 *   no session.
 * - `POST sign-out` and `GET session` (rule `agent-self`) read the agent session cookie only.
 *
 * Every route logs its outcome code with the correlation id; never an address, a password, a
 * code, a token or the handover code.
 */
@ApiTags('identity')
@RoutePopulation('agent')
@Controller('identity/agent')
export class AgentSessionController {
  readonly #logger = new Logger('AgentSessionController');

  constructor(
    private readonly signInAgent: SignInAgent,
    private readonly completeAgentSignIn: CompleteAgentSignIn,
    private readonly signOutAgent: SignOutAgent,
    private readonly describeAgentSession: DescribeAgentSession,
    private readonly startAcceptance: StartAgentInvitationAcceptance,
    private readonly acceptInvitation: AcceptAgentInvitation,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "An agent's password step",
    description:
      'Email and password. An unknown address, a wrong password and an account of another ' +
      'type or Market all answer credentials.invalid. A correct password never opens a ' +
      'session: the answer asks for a code and carries a challenge token.',
  })
  @ApiBody({ type: AdminSignInRequest })
  @ApiOkResponse({ type: AgentSignInStep })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: 'credentials.invalid' })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled or second-factor.locked (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async signIn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AgentSignInStep> {
    const input = adminBody(request, body, ['email', 'password'] as const);
    const client = adminClient(request);
    let outcome: AgentSignInStep | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.signInAgent.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else if (result.value.code === 'second-factor.locked') {
        outcome = adminFailure(response, result.value);
      } else if (result.value.code !== 'second-factor-required') {
        // An agent is never sent to an enrolment link; fail closed as a refused sign-in.
        outcome = fail(401, 'credentials.invalid');
      } else {
        response.setHeader('Cache-Control', 'no-store');
        outcome = {
          code: result.value.code,
          challengeToken: result.value.challengeToken,
          expiresAt: result.value.expiresAt.toString(),
        };
      }
    }
    return this.settle('identity.agent-sign-in', context, outcome);
  }

  @Post('second-factor')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "An agent's code step",
    description:
      'The challenge token of the password step and a code from the app, or a recovery code. ' +
      'On success the agent session cookie is set (it ends with the browser).',
  })
  @ApiBody({ type: AdminSecondFactorRequest })
  @ApiOkResponse({
    type: AdminSignedIn,
    headers: { 'Set-Cookie': { description: 'The agent session cookie' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, challenge.rejected or second-factor.invalid',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'account.disabled; request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'second-factor.locked or request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async secondFactor(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminSignedIn> {
    const input = adminBody(request, body, ['challengeToken', 'code'] as const);
    const client = adminClient(request);
    let outcome: AdminSignedIn | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.completeAgentSignIn.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else {
        response.setHeader(
          'Set-Cookie',
          sessionCookie('agent', context.market.marketId, result.value.token, null),
        );
        response.setHeader('Cache-Control', 'no-store');
        outcome = { code: 'signed-in', csrfToken: csrfTokenFor(result.value.token) };
      }
    }
    return this.settle('identity.agent-second-factor', context, outcome);
  }

  @Post('invitation/enrolment')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "Start accepting an agent invitation: the authenticator app's secret",
    description:
      "The invitation's token. Answers a new secret with a tag and an expiry 15 minutes ahead; " +
      'nothing is stored until the acceptance. The handover code is not asked here.',
  })
  @ApiBody({ type: AdminInvitationTokenRequest })
  @ApiOkResponse({ type: AdminInvitationEnrolmentReady })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or invitation.rejected',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async invitationEnrolment(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminInvitationEnrolmentReady> {
    const input = adminBody(request, body, ['token'] as const);
    const client = adminClient(request);
    let outcome: AdminInvitationEnrolmentReady | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.startAcceptance.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else {
        response.setHeader('Cache-Control', 'no-store');
        outcome = { ...result.value, expiresAt: result.value.expiresAt.toString() };
      }
    }
    return this.settle('identity.agent-invitation-enrolment', context, outcome);
  }

  @Post('invitation/accept')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Accept an agent invitation in one request',
    description:
      'The link token, the handover code, a password, the secret from the preview and the ' +
      'first code from the app. Creates the account with its active second factor and shows ten ' +
      'recovery codes once. No session is opened: the new agent signs in. A wrong handover code ' +
      'is handover-code.invalid; the fifth failure voids the code and the invitation must be reissued.',
  })
  @ApiBody({ type: AgentAcceptInvitationRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'validation.failed, invitation.rejected, handover-code.invalid, ' +
      'invitation.enrolment-expired, password.rejected or second-factor.invalid',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled or second-factor.locked (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async accept(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, [
      'token',
      'handoverCode',
      'password',
      'secret',
      'tag',
      'expiresAt',
      'code',
    ] as const);
    const client = adminClient(request);
    let outcome: RecoveryCodesShown | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.acceptInvitation.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else {
        response.setHeader('Cache-Control', 'no-store');
        outcome = { code: result.value.code, recoveryCodes: [...result.value.recoveryCodes] };
      }
    }
    return this.settle('identity.agent-invitation-accept', context, outcome);
  }

  @Post('sign-out')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign out of the current agent session',
    description: 'Revokes the session of the cookie and clears the cookie.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiOkResponse({ type: CustomerSignedOut })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async signOutOfSession(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSignedOut> {
    const result = await this.signOutAgent.execute(context, {});
    const outcome = result.ok ? result.value : adminFailure(response, result.error);
    if (result.ok) {
      response.setHeader('Set-Cookie', clearedSessionCookie('agent', context.market.marketId));
    }
    return this.settle('identity.agent-sign-out', context, outcome);
  }

  @Get('session')
  @ReadsSession()
  @ApiOperation({
    summary: 'The signed-in agent account and the session',
    description:
      'Ids, the email and name, the session lifetimes and the CSRF token. An agent holds no ' +
      'role and no permission. Not cached.',
  })
  @ApiOkResponse({ type: AgentSessionSummary })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async session(
    @Call() context: CallContext,
    @SessionCsrfToken() csrfToken: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AgentSessionSummary> {
    const result = await this.describeAgentSession.execute(context, {});
    let outcome: AgentSessionSummary | HttpException;
    if (!result.ok) outcome = adminFailure(response, result.error);
    else if (csrfToken === null) {
      outcome = fail(ACCESS_DENIED_STATUS['access.denied'], 'access.denied');
    } else {
      response.setHeader('Cache-Control', 'no-store');
      outcome = { ...result.value, population: 'agent', csrfToken };
    }
    this.settle(
      'identity.agent-session',
      context,
      outcome instanceof HttpException ? outcome : { code: 'described' },
    );
    return outcome as AgentSessionSummary;
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : ((outcome as { code?: string }).code ?? 'ok'),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
