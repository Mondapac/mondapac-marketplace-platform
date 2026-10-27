import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
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
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { VerifyAdminStepUp } from '../application/use-cases/verify-admin-step-up.use-case';
import { adminBody, adminFailure } from './admin.answer';
import { ApiErrorBody } from './customer-sign-up.dto';
import { StepUpVerified, StepUpVerifyRequest } from './seller-step-up.dto';

/**
 * A platform admin's fresh two-step code for one admin action over HTTP (issue #491). Behind the
 * admin session cookie, its CSRF token and the admin panel's origin; JSON only, with a closed
 * body. A registered admin action (for example `PUT /wallet/admin/settings`) without a proof
 * answers `403 second-factor.required` with `details.actionKey`: the panel shows the code dialog,
 * calls `verify` with that key, and repeats the request within five minutes. The route logs its
 * outcome code with the correlation id; never a code.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin/step-up')
export class AdminStepUpController {
  readonly #logger = new Logger('AdminStepUpController');

  constructor(private readonly verify: VerifyAdminStepUp) {}

  @Post('verify')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Present a two-step code for one admin action',
    description:
      'A platform admin with two-step set up (the factor used at admin sign-in). A current code ' +
      'from the app or a recovery code, counted on the same lock-out as the sign-in code. On ' +
      'success this session may do that one action for the next 5 minutes; it covers no other ' +
      'action and no other session. Refused in an acting-as session. Every success is audited ' +
      '(`identity.admin-step-up.verified`).',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: StepUpVerifyRequest })
  @ApiOkResponse({ type: StepUpVerified })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'step-up.action-unknown (not a registered admin action)',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'second-factor.unavailable (no two-step set up)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async verifyCode(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StepUpVerified> {
    const input = adminBody(request, body, ['actionKey', 'code'] as const);
    let outcome: StepUpVerified | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.verify.execute(context, input);
      outcome = result.ok ? result.value : adminFailure(response, result.error);
    }
    response.setHeader('Cache-Control', 'no-store');
    this.#logger.log({
      msg: 'identity.admin-step-up-verify',
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : outcome.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
