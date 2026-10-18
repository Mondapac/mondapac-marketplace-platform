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
import { SetPersonalization } from '../application/use-cases/set-personalization.use-case';
import { ViewPersonalization } from '../application/use-cases/view-personalization.use-case';
import { PersonalizationBody, PersonalizationRequest, personalizationBody } from './engagement.dto';
import { closedBody, logRoute, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const BODY_FIELDS: readonly string[] = ['enabled'];

/**
 * The signed-in customer's personalization switch (owner decision 4): on unless they switch it
 * off; off stops recording and deletes what was recorded. The customer comes from the session,
 * never from the body. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('engagement')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/personalization')
export class PersonalizationController {
  readonly #logger = new Logger('PersonalizationController');

  constructor(
    private readonly view: ViewPersonalization,
    private readonly set: SetPersonalization,
  ) {}

  @Get()
  @ApiOperation({ summary: "The customer's personalization switch" })
  @ApiOkResponse({ type: PersonalizationBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    logRoute(
      this.#logger,
      'engagement.view-personalization-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return personalizationBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Switch personalization on or off',
    description:
      'Off stops recording shopping behaviour and deletes what was recorded for the account. ' +
      'Setting the value it already has changes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PersonalizationRequest })
  @ApiOkResponse({ type: PersonalizationBody })
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
      'engagement.set-personalization-route',
      context,
      result.ok ? 'saved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return personalizationBody(result.value);
  }
}
