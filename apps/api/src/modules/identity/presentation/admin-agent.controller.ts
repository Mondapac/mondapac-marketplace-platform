import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { parseId } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS, RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ResetAgentSecondFactor } from '../application/use-cases/reset-agent-second-factor.use-case';
import { adminBody } from './admin.answer';
import { AdminEmptyRequest, AdminSecondFactorReset } from './admin-team.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'account.unknown': 404,
  'second-factor.none': 409,
  'conflict.stale': 409,
  'conflict.retry': 409,
  'access.unavailable': 503,
});

/**
 * An admin's routes on agent accounts (ADR-0045 decision 3). Behind the admin session cookie,
 * its CSRF token and the admin panel's origin; JSON only, with an empty body.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin/agents')
export class AdminAgentController {
  readonly #logger = new Logger('AdminAgentController');

  constructor(private readonly resetAgentSecondFactor: ResetAgentSecondFactor) {}

  @Post(':accountId/second-factor/reset')
  @HttpCode(200)
  @ReadsSession()
  @RequiresStepUp('identity.agent-account.reset-second-factor')
  @ApiOperation({
    summary: "Reset an agent's second factor",
    description:
      'Needs identity.agent-account.reset-second-factor and a fresh two-step code for that ' +
      'action. The factor and its recovery codes are removed and every session of the agent ' +
      'ends. Opens no session. A path id that is not an agent account answers account.unknown.',
  })
  @ApiParam({ name: 'accountId', description: 'The agent account. A UUID v7.' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminSecondFactorReset })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or unauthenticated',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, second-factor.required or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.none or conflict.retry' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resetSecondFactor(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminSecondFactorReset> {
    let outcome: AdminSecondFactorReset | HttpException;
    const parsed = parseId<'Account'>(rawAccountId);
    const input = adminBody(request, body, []);
    if (!parsed.ok) outcome = fail(404, 'account.unknown');
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.resetAgentSecondFactor.execute(context, {
        accountId: parsed.value,
      });
      outcome = result.ok
        ? { code: result.value.code, accountId: result.value.accountId }
        : fail(
            STATUS[result.error.code] ??
              ACCESS_DENIED_STATUS[result.error.code as keyof typeof ACCESS_DENIED_STATUS] ??
              500,
            result.error.code,
          );
    }
    this.#logger.log({
      msg: 'identity.admin-reset-agent-second-factor',
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
