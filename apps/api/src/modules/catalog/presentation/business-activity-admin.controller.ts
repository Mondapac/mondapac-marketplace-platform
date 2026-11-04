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
import { BusinessActivityCreate } from '../application/use-cases/business-activity-create.use-case';
import { BusinessActivityEdit } from '../application/use-cases/business-activity-edit.use-case';
import { BusinessActivityGet } from '../application/use-cases/business-activity-get.use-case';
import { BusinessActivityList } from '../application/use-cases/business-activity-list.use-case';
import {
  BusinessActivityCreateRequest,
  BusinessActivityEditRequest,
  BusinessActivityListBody,
  BusinessActivityWrapBody,
} from './business-activity.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin business-activity routes. A malformed request is
 * 400; an unknown activity is 404; a taken code or name and a stale version are 409; a name or
 * description that asserts a certification is 422; a missing dependency is 503.
 */
export const BUSINESS_ACTIVITY_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'business-activity.not-found': 404,
  'business-activity.code-taken': 409,
  'business-activity.name-taken': 409,
  'conflict.stale': 409,
  'business-activity.claim-word': 422,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    BUSINESS_ACTIVITY_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.business-activity-admin-unmapped-refusal',
  );

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const ACTIVITY_PARAM = { name: 'activityId', description: 'The business activity. A UUID v7.' };
const CONTENT_KEYS = ['code', 'description', 'categoryIds'] as const;

/**
 * Business-activity administration over HTTP (catalog business-activity package): list, read,
 * create and edit the activities of the request's Market. Every route reads the admin session
 * (`@ReadsSession`), so a write needs the CSRF token and the admin panel's origin; JSON only,
 * closed bodies. Thin adapters: each route calls one use case through its gate, which checks
 * `catalog.business-activity.read` (reads) or `.edit` (writes), and maps the answer to the error
 * format `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/business-activities')
export class BusinessActivityAdminController {
  readonly #logger = new Logger('BusinessActivityAdminController');

  constructor(
    private readonly listActivities: BusinessActivityList,
    private readonly getActivity: BusinessActivityGet,
    private readonly createActivity: BusinessActivityCreate,
    private readonly editActivity: BusinessActivityEdit,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List business activities',
    description:
      'Needs catalog.business-activity.read. By code, keyset-paged: send `nextAfterId` of the ' +
      'previous page as `afterId`. `status` filters; `search` matches a name in any locale or the ' +
      'code (server-side search for pickers). `limit` is 1 to 100 (default 25).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: BusinessActivityListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<BusinessActivityListBody> {
    const result = await this.listActivities.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as BusinessActivityListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.business-activity-list', context, outcome);
  }

  @Get(':activityId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read a business activity',
    description: 'Needs catalog.business-activity.read.',
  })
  @ApiParam(ACTIVITY_PARAM)
  @ApiOkResponse({ type: BusinessActivityWrapBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'business-activity.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('activityId') activityId: string,
  ): Promise<BusinessActivityWrapBody> {
    const result = await this.getActivity.execute(context, { activityId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as BusinessActivityWrapBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.business-activity-get', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a business activity',
    description:
      'Needs catalog.business-activity.edit. Active at once. The default-locale name is required; ' +
      'a name or description that asserts a certification is refused ' +
      '(business-activity.claim-word, details.fields).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BusinessActivityCreateRequest })
  @ApiCreatedResponse({ type: BusinessActivityWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'business-activity.code-taken or business-activity.name-taken',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'business-activity.claim-word (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BusinessActivityWrapBody> {
    const input = closedBody(request, body, ['names'], CONTENT_KEYS);
    let outcome: BusinessActivityWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createActivity.execute(context, input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BusinessActivityWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.business-activity-create', context, outcome);
  }

  @Put(':activityId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Replace the content of a business activity',
    description:
      'Needs catalog.business-activity.edit. The whole content and the version the admin saw: a ' +
      'field left out is cleared (status left out is unchanged). The code never changes.',
  })
  @ApiParam(ACTIVITY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: BusinessActivityEditRequest })
  @ApiOkResponse({ type: BusinessActivityWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'business-activity.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or business-activity.name-taken',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'business-activity.claim-word (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('activityId') activityId: string,
    @Body() body: unknown,
  ): Promise<BusinessActivityWrapBody> {
    const input = closedBody(
      request,
      body,
      ['version', 'names'],
      [...CONTENT_KEYS.filter((k) => k !== 'code'), 'status'],
    );
    let outcome: BusinessActivityWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editActivity.execute(context, { ...input, activityId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BusinessActivityWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.business-activity-edit', context, outcome);
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
