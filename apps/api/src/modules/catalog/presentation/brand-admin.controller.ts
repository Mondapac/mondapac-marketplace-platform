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
import { BrandApprove } from '../application/use-cases/brand-approve.use-case';
import { BrandArchive } from '../application/use-cases/brand-archive.use-case';
import { BrandCreate } from '../application/use-cases/brand-create.use-case';
import { BrandEdit } from '../application/use-cases/brand-edit.use-case';
import { BrandGet } from '../application/use-cases/brand-get.use-case';
import { BrandList } from '../application/use-cases/brand-list.use-case';
import { BrandMerge } from '../application/use-cases/brand-merge.use-case';
import { BrandMergeQueueDismiss } from '../application/use-cases/brand-merge-queue-dismiss.use-case';
import { BrandMergeQueueList } from '../application/use-cases/brand-merge-queue-list.use-case';
import {
  BrandCreateRequest,
  BrandDetailBody,
  BrandEditRequest,
  BrandListBody,
  BrandMergeBody,
  BrandMergeRequest,
  BrandVersionRequest,
  BrandWrapBody,
  MergeQueueBody,
  MergeQueueDismissedBody,
  MergeQueueDismissRequest,
} from './brand.dto';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin brand routes (catalog brand package). A malformed
 * request is 400; an unknown or malformed brand id is 404; a state that refuses the change (a taken
 * slug or look-alike name, a brand that is not a draft or is archived, a stale version, a merge
 * target that is not active) is 409; a merge of a brand into itself is 422; a missing dependency is
 * 503.
 */
export const BRAND_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'brand.slug-invalid': 400,
  'brand.not-found': 404,
  'brand-merge-queue.group-not-found': 404,
  'brand.slug-taken': 409,
  'brand.near-duplicate': 409,
  'brand.alias-taken': 409,
  'brand.slug-locked': 409,
  'brand.not-draft': 409,
  'brand.archived': 409,
  'brand.already-archived': 409,
  'brand.merge-target-not-active': 409,
  'brand.merge-source-archived': 409,
  'conflict.stale': 409,
  'brand.merge-into-itself': 422,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(BRAND_ADMIN_STATUS, error, response, context, 'catalog.brand-admin-unmapped-refusal');

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const BRAND_PARAM = { name: 'brandId', description: 'The brand. A UUID v7.' };
const CONTENT_KEYS = [
  'slug',
  'summary',
  'originCountry',
  'logoImageId',
  'logoAlt',
  'headerImageId',
] as const;

/**
 * Brand administration over HTTP (catalog brand package): list, read, create, edit, archive and
 * approve brands, merge brands, and settle the merge queue. Every route reads the admin session of
 * the request's Market (`@ReadsSession`), so a write needs the CSRF token and the admin panel's
 * origin; JSON only, closed bodies. Thin adapters: each route calls one use case through its gate,
 * which checks `catalog.brand.read` (reads) or `catalog.brand.edit` (writes), and maps the answer
 * to the error format `{ statusCode, code, details? }`. Every route logs its outcome code with the
 * correlation id; never a body or a text.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/brands')
export class BrandAdminController {
  readonly #logger = new Logger('BrandAdminController');

  constructor(
    private readonly listBrands: BrandList,
    private readonly getBrand: BrandGet,
    private readonly createBrand: BrandCreate,
    private readonly editBrand: BrandEdit,
    private readonly archiveBrand: BrandArchive,
    private readonly approveBrand: BrandApprove,
    private readonly mergeBrands: BrandMerge,
    private readonly mergeQueue: BrandMergeQueueList,
    private readonly dismissGroup: BrandMergeQueueDismiss,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List brands',
    description:
      'Needs catalog.brand.read. By name, keyset-paged: send `nextAfterId` of the previous page ' +
      'as `afterId`. `status` filters; `search` matches the name, the slug or an alias. `limit` is ' +
      '1 to 100 (default 25).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'active', 'archived'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'afterId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: BrandListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<BrandListBody> {
    const result = await this.listBrands.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as BrandListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.brand-list', context, outcome);
  }

  @Get('merge-queue')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the merge queue',
    description:
      'Needs catalog.brand.read. Groups of brands whose names are near-duplicates of each other ' +
      '(case, punctuation, "&" or "and"), found by the migration. Nothing is merged by itself: ' +
      'settle a group with POST /catalog/admin/brands/{brandId}/merge or merge-queue/dismiss.',
  })
  @ApiOkResponse({ type: MergeQueueBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async queue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<MergeQueueBody> {
    const result = await this.mergeQueue.execute(context, query as Record<string, never>);
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as MergeQueueBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.brand-merge-queue-list', context, outcome);
  }

  @Post('merge-queue/dismiss')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Keep the brands of a merge-queue group apart',
    description:
      'Needs catalog.brand.edit. Resolves every open row of the group as kept-separate; the ' +
      'brands are untouched.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: MergeQueueDismissRequest })
  @ApiOkResponse({ type: MergeQueueDismissedBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand-merge-queue.group-not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async dismiss(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<MergeQueueDismissedBody> {
    const input = closedBody(request, body, ['groupKey']);
    let outcome: MergeQueueDismissedBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.dismissGroup.execute(context, { groupKey: input.groupKey });
      outcome = result.ok ? { ...result.value } : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-merge-queue-dismiss', context, outcome);
  }

  @Get(':brandId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read a brand',
    description:
      'Needs catalog.brand.read. A brand of any status with its aliases and the number of ' +
      "the request's Market products that use it.",
  })
  @ApiParam(BRAND_PARAM)
  @ApiOkResponse({ type: BrandDetailBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('brandId') brandId: string,
  ): Promise<BrandDetailBody> {
    const result = await this.getBrand.execute(context, { brandId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as BrandDetailBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.brand-get', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a brand',
    description:
      'Needs catalog.brand.edit. The brand is active at once and the admin is its approver. A ' +
      'name that is a near-duplicate of a live brand is refused (brand.near-duplicate, ' +
      'details.brands).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandCreateRequest })
  @ApiCreatedResponse({ type: BrandWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'brand.slug-taken or brand.near-duplicate (details.brands)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<BrandWrapBody> {
    const input = closedBody(request, body, ['name'], CONTENT_KEYS);
    let outcome: BrandWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createBrand.execute(context, input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BrandWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-create', context, outcome);
  }

  @Put(':brandId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Replace the content of a brand',
    description:
      'Needs catalog.brand.edit. The whole content and the version the admin saw: a field left ' +
      'out is cleared. The slug changes only while the brand is a draft. An archived brand cannot ' +
      'be edited.',
  })
  @ApiParam(BRAND_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandEditRequest })
  @ApiOkResponse({ type: BrandWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, brand.archived, brand.slug-locked, brand.slug-taken or brand.near-duplicate',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ): Promise<BrandWrapBody> {
    const input = closedBody(request, body, ['version', 'name'], CONTENT_KEYS);
    let outcome: BrandWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editBrand.execute(context, { ...input, brandId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BrandWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-edit', context, outcome);
  }

  @Post(':brandId/archive')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Archive a brand',
    description:
      'Needs catalog.brand.edit. A draft or active brand becomes archived: its public page stops ' +
      'answering; products keep their brand. This also turns down a seller proposal.',
  })
  @ApiParam(BRAND_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandVersionRequest })
  @ApiOkResponse({ type: BrandWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or brand.already-archived',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async archive(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ): Promise<BrandWrapBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: BrandWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.archiveBrand.execute(context, { brandId, version: input.version });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BrandWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-archive', context, outcome);
  }

  @Post(':brandId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a draft brand',
    description:
      "Needs catalog.brand.edit. A seller's proposal becomes active: its public page answers and " +
      'product values that name it resolve to it.',
  })
  @ApiParam(BRAND_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandVersionRequest })
  @ApiOkResponse({ type: BrandWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'conflict.stale or brand.not-draft' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ): Promise<BrandWrapBody> {
    const input = closedBody(request, body, ['version']);
    let outcome: BrandWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approveBrand.execute(context, { brandId, version: input.version });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BrandWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-approve', context, outcome);
  }

  @Post(':brandId/merge')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge brands into this brand',
    description:
      'Needs catalog.brand.edit. The brand of the path is the target and must be active. Each ' +
      "source brand is archived; the request's Market products that pointed at it point at the " +
      'target; its name and aliases become aliases of the target. Extra `aliases` are recorded ' +
      'too. Brands are shared by every Market, so the same merge run by an admin of another ' +
      "Market moves that Market's products. The merge queue rows of the sources are resolved.",
  })
  @ApiParam(BRAND_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: BrandMergeRequest })
  @ApiOkResponse({ type: BrandMergeBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'brand.merge-target-not-active, brand.merge-source-archived, brand.alias-taken (details.brands) or conflict.stale',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'brand.merge-into-itself' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async merge(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ): Promise<BrandMergeBody> {
    const input = closedBody(request, body, [], ['sourceBrandIds', 'aliases']);
    let outcome: BrandMergeBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.mergeBrands.execute(context, { ...input, brandId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as BrandMergeBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.brand-merge', context, outcome);
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
