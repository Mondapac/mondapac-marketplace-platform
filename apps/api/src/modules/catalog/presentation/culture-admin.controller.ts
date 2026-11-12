import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Patch,
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
  ApiExtraModels,
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
import { CultureCategoryMarks } from '../application/use-cases/culture-category-marks.use-case';
import { CultureCategoryMarkSet } from '../application/use-cases/culture-category-mark-set.use-case';
import { CultureCategoryMarkClear } from '../application/use-cases/culture-category-mark-clear.use-case';
import { CultureCreate } from '../application/use-cases/culture-create.use-case';
import { CultureEdit } from '../application/use-cases/culture-edit.use-case';
import { CultureGet } from '../application/use-cases/culture-get.use-case';
import { CultureList } from '../application/use-cases/culture-list.use-case';
import {
  CultureCategoryMarkClearBody,
  CultureCategoryMarkSetRequest,
  CultureCategoryMarksBody,
  CultureCategoryMarkWrapBody,
  CultureCreateRequest,
  CultureEditRequest,
  CultureListBody,
  CultureNameBody,
  CultureWrapBody,
} from './culture.dto';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin culture routes. A malformed request is 400; an
 * unknown culture or mark row is 404; a taken code or name, a stale version, a full Market and a
 * broken culture rule (the default stays active, status moves) are 409; text that asserts a
 * certification is 422; a missing dependency is 503.
 */
export const CULTURE_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'culture.not-found': 404,
  'culture-category.not-found': 404,
  'culture.code-taken': 409,
  'culture.name-taken': 409,
  'culture.limit-reached': 409,
  'culture.required-type-locked': 409,
  'culture.status-transition': 409,
  'culture.default-must-stay-active': 409,
  'culture.default-must-be-active': 409,
  'culture.default-required': 409,
  'conflict.stale': 409,
  'culture.claim-word': 422,
  'culture.locale-uncheckable': 422,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    CULTURE_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.culture-admin-unmapped-refusal',
  );

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const CULTURE_PARAM = { name: 'cultureId', description: 'The culture. A UUID v7.' };
const CATEGORY_PARAM = { name: 'categoryId', description: 'The platform category. A UUID v7.' };
const RULES =
  'culture.status-transition, culture.default-must-stay-active, culture.default-must-be-active, ' +
  'culture.default-required, culture.name-taken, culture.code-taken, culture.limit-reached or ' +
  'conflict.stale';

/**
 * Culture administration over HTTP (multi-culture package 1; ADR-0047): list, read, create and edit
 * the cultures of the request's Market, and read and set their marks on categories. There is no
 * delete route: a culture is made inactive. Every route reads the admin session (`@ReadsSession`),
 * so a write needs the CSRF token and the admin panel's origin; JSON only, closed bodies. Thin
 * adapters: each route calls one use case through its gate, which checks `catalog.culture.read`
 * (reads) or `catalog.culture.edit` (writes; protected), and maps the answer to the error format
 * `{ statusCode, code, details? }`.
 */
@ApiTags('catalog')
@ApiExtraModels(CultureNameBody)
@RoutePopulation('admin')
@Controller('catalog/admin/cultures')
export class CultureAdminController {
  readonly #logger = new Logger('CultureAdminController');

  constructor(
    private readonly listCultures: CultureList,
    private readonly getCulture: CultureGet,
    private readonly createCulture: CultureCreate,
    private readonly editCulture: CultureEdit,
    private readonly readMarks: CultureCategoryMarks,
    private readonly setMark: CultureCategoryMarkSet,
    private readonly clearMark: CultureCategoryMarkClear,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List cultures',
    description:
      'Needs catalog.culture.read. By display order, then code; not paged. `status` filters; ' +
      '`search` matches a name in any locale or the code. The answer carries no seller or product ' +
      'counts yet (later packages).',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'active', 'inactive'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiOkResponse({ type: CultureListBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<CultureListBody> {
    const result = await this.listCultures.execute(context, query);
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CultureListBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.culture-list', context, outcome);
  }

  @Get(':cultureId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({ summary: 'Read a culture', description: 'Needs catalog.culture.read.' })
  @ApiParam(CULTURE_PARAM)
  @ApiOkResponse({ type: CultureWrapBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'culture.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('cultureId') cultureId: string,
  ): Promise<CultureWrapBody> {
    const result = await this.getCulture.execute(context, { cultureId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CultureWrapBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.culture-get', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a culture',
    description:
      'Needs catalog.culture.edit (protected). A draft at once. The default-locale name and ' +
      'description are required; text that asserts a certification is refused ' +
      '(culture.claim-word, details.fields). A required certification type must be an active type ' +
      'of the Market.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: CultureCreateRequest })
  @ApiCreatedResponse({ type: CultureWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ type: ApiErrorBody, description: RULES })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'culture.claim-word or culture.locale-uncheckable (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CultureWrapBody> {
    const input = closedBody(
      request,
      body,
      ['code', 'names'],
      ['displayOrder', 'badgeColour', 'requiredCertificationType'],
    );
    let outcome: CultureWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createCulture.execute(context, input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as CultureWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.culture-create', context, outcome);
  }

  @Patch(':cultureId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Edit a culture',
    description:
      'Needs catalog.culture.edit (protected). The version the admin saw, and any of: names (the ' +
      'whole set), displayOrder, status, badgeColour, requiredCertificationType (null clears), ' +
      'isDefault (true makes it the Market default; the previous default is unmarked). A field ' +
      'left out is unchanged. The code never changes. The default culture cannot be made ' +
      'inactive. Each edit is audited.',
  })
  @ApiParam(CULTURE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CultureEditRequest })
  @ApiOkResponse({ type: CultureWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'culture.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: RULES })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'culture.claim-word or culture.locale-uncheckable (details.fields)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('cultureId') cultureId: string,
    @Body() body: unknown,
  ): Promise<CultureWrapBody> {
    const input = closedBody(
      request,
      body,
      ['version'],
      ['names', 'displayOrder', 'status', 'badgeColour', 'requiredCertificationType', 'isDefault'],
    );
    let outcome: CultureWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editCulture.execute(context, { ...input, cultureId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as CultureWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.culture-edit', context, outcome);
  }

  @Get(':cultureId/categories')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read the category marks of a culture',
    description:
      "Needs catalog.culture.read. Every live category with the culture's own row (or null) and " +
      'the effective visibility and certification mark, with where each came from. No row ' +
      'anywhere up the tree means visible and "required".',
  })
  @ApiParam(CULTURE_PARAM)
  @ApiOkResponse({ type: CultureCategoryMarksBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'culture.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async marks(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('cultureId') cultureId: string,
  ): Promise<CultureCategoryMarksBody> {
    const result = await this.readMarks.execute(context, { cultureId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CultureCategoryMarksBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.culture-category-marks', context, outcome);
  }

  @Put(':cultureId/categories/:categoryId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Set the mark of a culture on a category',
    description:
      'Needs catalog.culture.edit (protected). Creates or replaces the row: `visible` (true, ' +
      'false, or null to inherit; left out with a mark: inherit; left out with no mark: true) and ' +
      '`certificationMark` (required, neutral, or null to inherit). The category must be live. ' +
      'Descendants inherit the mark from the nearest ancestor with one; a hidden category hides ' +
      'its whole branch. Audited.',
  })
  @ApiParam(CULTURE_PARAM)
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CultureCategoryMarkSetRequest })
  @ApiOkResponse({ type: CultureCategoryMarkWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'culture.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async setCategoryMark(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('cultureId') cultureId: string,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CultureCategoryMarkWrapBody> {
    const input = closedBody(request, body, [], ['visible', 'certificationMark']);
    let outcome: CultureCategoryMarkWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.setMark.execute(context, { ...input, cultureId, categoryId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as CultureCategoryMarkWrapBody)
        : refusal(result.error, response, context);
    }
    return this.settle('catalog.culture-category-mark-set', context, outcome);
  }

  @Delete(':cultureId/categories/:categoryId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Clear the mark of a culture on a category',
    description:
      'Needs catalog.culture.edit (protected). Removes the row, so the category inherits again. ' +
      'Audited.',
  })
  @ApiParam(CULTURE_PARAM)
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: CultureCategoryMarkClearBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'culture.not-found or culture-category.not-found',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async clearCategoryMark(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('cultureId') cultureId: string,
    @Param('categoryId') categoryId: string,
  ): Promise<CultureCategoryMarkClearBody> {
    const result = await this.clearMark.execute(context, { cultureId, categoryId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CultureCategoryMarkClearBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.culture-category-mark-clear', context, outcome);
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
