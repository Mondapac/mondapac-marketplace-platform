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
import { TopicSuggestionApprove } from '../application/use-cases/topic-suggestion-approve.use-case';
import { TopicSuggestionList } from '../application/use-cases/topic-suggestion-list.use-case';
import { TopicSuggestionMap } from '../application/use-cases/topic-suggestion-map.use-case';
import { TopicSuggestionReject } from '../application/use-cases/topic-suggestion-reject.use-case';
import { TOPIC_ADMIN_STATUS } from './topic-admin.controller';
import {
  SuggestionApproveRequest,
  SuggestionDecisionWrapBody,
  SuggestionListBody,
  SuggestionMapRequest,
  SuggestionRejectRequest,
} from './topic-suggestion.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin tag-suggestion routes: the topic routes' map (the
 * claim-word and term refusals of an approval are the same as a create's), plus an unknown
 * suggestion (404), one that moved on or was decided (409) and the rules of a decision (422).
 */
export const TOPIC_SUGGESTION_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...TOPIC_ADMIN_STATUS,
  'suggestion.not-found': 404,
  'suggestion.stale': 409,
  'suggestion.not-open': 409,
  'suggestion.topic-invalid': 422,
  'suggestion.reason-invalid': 422,
  'suggestion.label-invalid': 422,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    TOPIC_SUGGESTION_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.topic-suggestion-unmapped-refusal',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NEEDS = 'Needs catalog.topic-suggestion.review; refused in an acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const SUGGESTION_PARAM = { name: 'suggestionId', description: 'The suggestion. A UUID v7.' };
const DECIDE_CONFLICT = 'suggestion.stale or suggestion.not-open';

/**
 * The queue of sellers' tag suggestions and the three decisions on one (product tags
 * package T5). Every route reads the admin session of the request's Market; the list answers
 * `no-store`; writes need the CSRF token, JSON and closed bodies. Thin adapters: each route calls
 * one use case through its gate and maps the answer to `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/topic-suggestions')
export class TopicSuggestionController {
  readonly #logger = new Logger('TopicSuggestionController');

  constructor(
    private readonly listOpen: TopicSuggestionList,
    private readonly approveOne: TopicSuggestionApprove,
    private readonly mapOne: TopicSuggestionMap,
    private readonly rejectOne: TopicSuggestionReject,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Tag suggestions waiting for a decision',
    description:
      `${NEEDS} Open suggestions, oldest first. The seller’s text is plain text: show it as ` +
      'text, never as markup.',
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
    return this.settle('catalog.topic-suggestion-list', context, outcome);
  }

  @Post(':suggestionId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a tag from the suggestion',
    description:
      `${NEEDS} Approving also needs catalog.topic.manage. The tag is created active, in the ` +
      'given group, named as given (default: the seller’s text); its name and slug pass the ' +
      'claim-word check and the term-taken check of tag creation. The seller is told by mail; ' +
      'their product is not changed.',
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
      'topic.claim-word or topic.locale-uncheckable (details.fields), or suggestion.* rule',
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
      'catalog.topic-suggestion-approve',
      context,
      response,
      closedBody(request, body, ['version', 'group'], ['name', 'slug']),
      (input) => this.approveOne.execute(context, { ...input, suggestionId }),
    );
  }

  @Post(':suggestionId/map')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Point the suggestion at a tag the list already has',
    description: `${NEEDS} The tag must exist and be active. The seller is told by mail.`,
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
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'suggestion.topic-invalid' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async map(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('suggestionId') suggestionId: string,
    @Body() body: unknown,
  ): Promise<SuggestionDecisionWrapBody> {
    return this.decide(
      'catalog.topic-suggestion-map',
      context,
      response,
      closedBody(request, body, ['version', 'topicId']),
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
      'catalog.topic-suggestion-reject',
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
