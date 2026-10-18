import { Body, Controller, Get, HttpCode, Logger, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
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
import { SetEmailPreferences } from '../application/use-cases/set-email-preferences.use-case';
import { ViewEmailPreferences } from '../application/use-cases/view-email-preferences.use-case';
import {
  EmailPreferencesBody,
  EmailPreferencesRequest,
  emailPreferencesBody,
} from './email-preferences.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const BODY_FIELDS: readonly string[] = ['marketing', 'source'];

/** Logs the route's outcome: a code, never the consent value or an id of the customer's. */
function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The signed-in customer's email preferences: marketing email consent (express opt-in). Thin
 * adapters: the customer comes from the session, never from the body. The sign-up page sends its
 * unticked box here right after the account exists (`source: sign-up`); the account page changes
 * it later. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('legal')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/email-preferences')
export class EmailPreferencesController {
  readonly #logger = new Logger('EmailPreferencesController');

  constructor(
    private readonly view: ViewEmailPreferences,
    private readonly set: SetEmailPreferences,
  ) {}

  @Get()
  @ApiOperation({ summary: "The customer's email preferences (marketing consent)" })
  @ApiOkResponse({ type: EmailPreferencesBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    logRoute(
      this.#logger,
      'legal.view-email-preferences-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return emailPreferencesBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give or withdraw marketing email consent',
    description:
      'Express opt-in: marketing email is sent only after marketing is set to true. ' +
      'Setting the value it already has records nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: EmailPreferencesRequest })
  @ApiOkResponse({ type: EmailPreferencesBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, BODY_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.set.execute(context, requestBody as Record<string, unknown>);
    logRoute(
      this.#logger,
      'legal.set-email-preferences-route',
      context,
      result.ok ? 'saved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return emailPreferencesBody(result.value);
  }
}
