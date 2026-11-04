import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
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
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AttributeSuggestionApprove } from '../application/use-cases/attribute-suggestion-approve.use-case';
import { AttributeSuggestionList } from '../application/use-cases/attribute-suggestion-list.use-case';
import { AttributeSuggestionMap } from '../application/use-cases/attribute-suggestion-map.use-case';
import { AttributeSuggestionReject } from '../application/use-cases/attribute-suggestion-reject.use-case';
import { ATTRIBUTE_ADMIN_STATUS } from './attribute-admin.controller';
import {
  SuggestionApproveRequest,
  SuggestionDecisionWrapBody,
  SuggestionListBody,
  SuggestionMapRequest,
  SuggestionRejectRequest,
} from './attribute-suggestion.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin suggestion routes: the attribute routes' map (the
 * claim-text and label refusals of an approval are the same as an edit's), plus an unknown
 * suggestion (404), one that moved on or was decided (409) and the rules of a decision (422).
 */
export const SUGGESTION_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...ATTRIBUTE_ADMIN_STATUS,
  'suggestion.not-found': 404,
  'suggestion.stale': 409,
  'suggestion.not-open': 409,
  'suggestion.attribute-unavailable': 409,
  'suggestion.attribute-protected': 409,
  'attribute-definition.not-published': 409,
  'suggestion.option-invalid': 422,
  'suggestion.reason-invalid': 422,
  'suggestion.label-invalid': 422,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    SUGGESTION_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.attribute-suggestion-unmapped-refusal',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NEEDS = 'Needs catalog.attribute-suggestion.decide; refused in an acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const SUGGESTION_PARAM = { name: 'suggestionId', description: 'The suggestion. A UUID v7.' };
const DECIDE_CONFLICT =
  'suggestion.stale, suggestion.not-open, suggestion.attribute-unavailable or ' +
  'suggestion.attribute-protected';

/**
 * The queue of sellers' value suggestions and the three decisions on one (attributes plan,
 * package A5). Every route reads the admin session of the request's Market; the list answers
 * `no-store`; writes need the CSRF token, JSON and closed bodies. Thin adapters: each route calls
 * one use case through its gate and maps the answer to `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/attribute-suggestions')
export class AttributeSuggestionController {
  readonly #logger = new Logger('AttributeSuggestionController');

  constructor(
    private readonly listOpen: AttributeSuggestionList,
    private readonly approveOne: AttributeSuggestionApprove,
    private readonly mapOne: AttributeSuggestionMap,
    private readonly rejectOne: AttributeSuggestionReject,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Value suggestions waiting for a decision',
    description:
      `${NEEDS} Open suggestions, oldest first, each with its attribute and the values it ` +
      'has. The seller’s text is plain text: show it as text, never as markup.',
  })
  @ApiOkResponse({ type: SuggestionListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<SuggestionListBody> {
    const result = await this.listOpen.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as SuggestionListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.attribute-suggestion-list', context, outcome);
  }

  @Post(':suggestionId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add the suggested value to the attribute',
    description:
      `${NEEDS} The admin writes the value’s label in each required language (the Market’s ` +
      'default); the labels pass the claim-text check. The attribute gets its next revision with ' +
      'the value added last and active. The seller is told by mail; their product is not changed.',
  })
  @ApiParam(SUGGESTION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SuggestionApproveRequest })
  @ApiOkResponse({ type: SuggestionDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'suggestion.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECIDE_CONFLICT })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'attribute.claim-word or attribute.locale-uncheckable (details.fields), or an ' +
      'attribute-definition.* content rule',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ): Promise<SuggestionDecisionWrapBody> {
    return this.decide(
      'catalog.attribute-suggestion-approve',
      context,
      response,
      closedBody(request, body, ['version', 'labels'], ['optionCode']),
      (input) => this.approveOne.execute(context, { ...input, suggestionId }),
    );
  }

  @Post(':suggestionId/map')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Point the suggestion at a value the attribute already has',
    description: `${NEEDS} The value must exist and be active. The seller is told by mail.`,
  })
  @ApiParam(SUGGESTION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SuggestionMapRequest })
  @ApiOkResponse({ type: SuggestionDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'suggestion.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECIDE_CONFLICT })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'suggestion.option-invalid' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async map(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ): Promise<SuggestionDecisionWrapBody> {
    return this.decide(
      'catalog.attribute-suggestion-map',
      context,
      response,
      closedBody(request, body, ['version', 'optionCode']),
      (input) => this.mapOne.execute(context, { ...input, suggestionId }),
    );
  }

  @Post(':suggestionId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject the suggestion with a reason',
    description: `${NEEDS} The reason (1 to 300 characters) is sent to the seller by mail.`,
  })
  @ApiParam(SUGGESTION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SuggestionRejectRequest })
  @ApiOkResponse({ type: SuggestionDecisionWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'suggestion.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECIDE_CONFLICT })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'suggestion.reason-invalid' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async reject(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ): Promise<SuggestionDecisionWrapBody> {
    return this.decide(
      'catalog.attribute-suggestion-reject',
      context,
      response,
      closedBody(request, body, ['version', 'reason']),
      (input) => this.rejectOne.execute(context, { ...input, suggestionId }),
    );
  }

  private async decide(
    msg: string,
    context: CallContext,
    response: Response,
    input: Record<string, unknown> | HttpException,
    run: (
      input: Record<string, unknown>,
    ) => Promise<{ ok: true; value: object } | { ok: false; error: Refusal }>,
  ): Promise<SuggestionDecisionWrapBody> {
    let outcome: SuggestionDecisionWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await run(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as SuggestionDecisionWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle(msg, context, outcome);
  }

  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
