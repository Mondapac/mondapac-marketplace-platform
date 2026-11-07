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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import { TopicCreate } from '../application/use-cases/topic-create.use-case';
import { TopicEdit } from '../application/use-cases/topic-edit.use-case';
import { TopicGet } from '../application/use-cases/topic-get.use-case';
import { TopicList } from '../application/use-cases/topic-list.use-case';
import { TopicCreateRequest, TopicEditRequest, TopicListBody, TopicWrapBody } from './topic.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin topic routes. A malformed request is 400; an
 * unknown topic is 404; a taken slug or term and a stale version are 409; a name, synonym or intro
 * that asserts a certification is 422; a missing dependency is 503.
 */
export const TOPIC_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'topic.not-found': 404,
  'topic.slug-taken': 409,
  'topic.term-taken': 409,
  'conflict.stale': 409,
  'topic.claim-word': 422,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(TOPIC_ADMIN_STATUS, error, response, context, 'catalog.topic-admin-unmapped-refusal');

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const TOPIC_PARAM = { name: 'topicId', description: 'The topic. A UUID v7.' };
const OPTIONAL_KEYS = ['synonyms', 'intro'] as const;

/**
 * Topic administration over HTTP (product tags package T1): list, read, create and edit the
 * curated topics ("tags" in the panels) of the request's Market. Every route reads the admin
 * session (`@ReadsSession`), so a write needs the CSRF token and the admin panel's origin; JSON
 * only, closed bodies. Thin adapters: each route calls one use case through its gate, which checks
 * `catalog.topic.read` (reads) or `catalog.topic.manage` (writes), and maps the answer to the
 * error format `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/topics')
export class TopicAdminController {
  readonly #logger = new Logger('TopicAdminController');

  constructor(
    private readonly listTopics: TopicList,
    private readonly getTopic: TopicGet,
    private readonly createTopic: TopicCreate,
    private readonly editTopic: TopicEdit,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List topics',
    description:
      'Needs catalog.topic.read. By slug, keyset-paged: send `nextAfterId` of the previous page as ' +
      '`afterId`. `status` and `group` filter; `search` matches a name or synonym in any locale ' +
      'or the slug. `limit` is 1 to 100 (default 25).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'archived'] })
  @ApiQuery({ name: 'group', required: false, enum: ['occasion', 'cuisine', 'use'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: TopicListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<TopicListBody> {
    const result = await this.listTopics.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as TopicListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.topic-list', context, outcome);
  }

  @Get(':topicId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({ summary: 'Read a topic', description: 'Needs catalog.topic.read.' })
  @ApiParam(TOPIC_PARAM)
  @ApiOkResponse({ type: TopicWrapBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'topic.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('topicId') topicId: string,
  ): Promise<TopicWrapBody> {
    const result = await this.getTopic.execute(context, { topicId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as TopicWrapBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.topic-get', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a topic',
    description:
      'Needs catalog.topic.manage. Active at once. The default-locale name is required; a name, ' +
      'synonym or intro that asserts a certification is refused (topic.claim-word, ' +
      'details.fields); a term another topic uses is refused (topic.term-taken, details.fields).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: TopicCreateRequest })
  @ApiCreatedResponse({ type: TopicWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'topic.slug-taken or topic.term-taken (details.fields when known)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'topic.claim-word (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<TopicWrapBody> {
    const input = closedBody(request, body, ['group', 'names'], ['slug', ...OPTIONAL_KEYS]);
    let outcome: TopicWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createTopic.execute(context, input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as TopicWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.topic-create', context, outcome);
  }

  @Put(':topicId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Replace the content of a topic',
    description:
      'Needs catalog.topic.manage. The whole content and the version the admin saw: synonyms or ' +
      'intro left out are cleared (status left out is unchanged). The slug never changes.',
  })
  @ApiParam(TOPIC_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: TopicEditRequest })
  @ApiOkResponse({ type: TopicWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'topic.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or topic.term-taken (details.fields when known)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'topic.claim-word (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('topicId') topicId: string,
    @Body() body: unknown,
  ): Promise<TopicWrapBody> {
    const input = closedBody(
      request,
      body,
      ['version', 'group', 'names'],
      [...OPTIONAL_KEYS, 'status'],
    );
    let outcome: TopicWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editTopic.execute(context, { ...input, topicId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as TopicWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.topic-edit', context, outcome);
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
