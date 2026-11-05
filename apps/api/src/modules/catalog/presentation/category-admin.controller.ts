import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Patch,
  Post,
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
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CategoryChangeSlug } from '../application/use-cases/category-change-slug.use-case';
import { CategoryCreate } from '../application/use-cases/category-create.use-case';
import { CategoryDiscard } from '../application/use-cases/category-discard.use-case';
import { CategoryEditDetails } from '../application/use-cases/category-edit-details.use-case';
import { CategoryHide } from '../application/use-cases/category-hide.use-case';
import { CategoryReorder } from '../application/use-cases/category-reorder.use-case';
import { CategoryShow } from '../application/use-cases/category-show.use-case';
import { CategoryAdminGet } from '../application/use-cases/category-admin-get.use-case';
import { CategoryAdminTree } from '../application/use-cases/category-admin-tree.use-case';
import { CategoryImpact } from '../application/use-cases/category-impact.use-case';
import {
  CategoryChangeSlugRequest,
  CategoryCreateRequest,
  CategoryDetailBody,
  CategoryEditDetailsRequest,
  CategoryImpactBody,
  CategoryReorderRequest,
  CategoryTreeBody,
  CategoryTreeVersionRequest,
  CategoryWriteWrapBody,
} from './category-admin.dto';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin category read routes (categories package C1). A
 * malformed request is 400; an unknown, malformed or other-Market category id is 404 with the same
 * body; a tree that cannot be built is 503, like a missing dependency.
 */
export const CATEGORY_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'category.not-found': 404,
  'category.parent-not-found': 404,
  'conflict.stale': 409,
  'category.slug-taken': 409,
  'category.slug-unchanged': 409,
  'category.sibling-name-taken': 409,
  'category.already-hidden': 409,
  'category.not-hidden': 409,
  'category.parent-hidden': 409,
  'category.not-editable': 409,
  'category.reorder-edge': 409,
  'category.not-discardable': 409,
  'category.depth-exceeded': 422,
  'category.required-locale-missing': 422,
  'category.cascade-too-large': 422,
  'category.claim-word': 422,
  'category.locale-uncheckable': 422,
  'catalog.categories-unavailable': 503,
  'claim-text.check-unavailable': 503,
  'access.unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    CATEGORY_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.category-admin-unmapped-refusal',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const CATEGORY_PARAM = { name: 'categoryId', description: 'The category. A UUID v7.' };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const EDITS =
  'Needs catalog.category-tree.edit; refused in an acting-as session. A structural write names ' +
  'the tree version the page read (`conflict.stale` when another admin changed the tree).';
const WRITE_422 =
  'category.claim-word or category.locale-uncheckable (details.fields), ' +
  'category.required-locale-missing (details.fields), category.depth-exceeded or ' +
  'category.cascade-too-large (details.max)';

/**
 * The platform category tree for the admin panel, read only (categories package C1): the whole
 * tree, one category with its history, and the impact of a structural change. Every route reads the
 * admin session of the request's Market and needs `catalog.category-tree.view`; the write routes
 * arrive with C3 and C4. Thin adapters: each calls one use case through its gate and maps the answer
 * to the error format `{ statusCode, code, details? }`. A category of another Market is not found.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/categories')
export class CategoryAdminController {
  readonly #logger = new Logger('CategoryAdminController');

  constructor(
    private readonly tree: CategoryAdminTree,
    private readonly getCategory: CategoryAdminGet,
    private readonly impact: CategoryImpact,
    private readonly createCategory: CategoryCreate,
    private readonly editDetails: CategoryEditDetails,
    private readonly reorderCategory: CategoryReorder,
    private readonly hideCategory: CategoryHide,
    private readonly showCategory: CategoryShow,
    private readonly changeSlug: CategoryChangeSlug,
    private readonly discardCategory: CategoryDiscard,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the whole category tree',
    description:
      'Needs catalog.category-tree.view. Every category in any status, depth first, with names by ' +
      'locale, depth, position, and the counts of live products and Offers. The counts are ' +
      'bounded at 10 seconds; `complete: false` means "at least". `actions` says what the caller ' +
      'may do on the page.',
  })
  @ApiOkResponse({ type: CategoryTreeBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or catalog.categories-unavailable',
  })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<CategoryTreeBody> {
    const result = await this.tree.execute(context, query as Record<string, never>);
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CategoryTreeBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.category-admin-tree', context, outcome);
  }

  @Get(':categoryId/impact')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'See what a change to a category would touch',
    description:
      'Needs catalog.category-tree.view. Published products in the subtree, their Offers, listed ' +
      'Offers and Offers with an active certification tag. Advisory: a change re-checks its own ' +
      'guards. Bounded at 10 seconds; `complete: false` means "at least".',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiQuery({ name: 'action', required: true, enum: ['move', 'merge', 'archive'] })
  @ApiOkResponse({ type: CategoryImpactBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or catalog.categories-unavailable',
  })
  async readImpact(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Query('action') action: unknown,
  ): Promise<CategoryImpactBody> {
    const result = await this.impact.execute(context, { categoryId, action });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CategoryImpactBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.category-impact', context, outcome);
  }

  @Get(':categoryId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read a category',
    description:
      'Needs catalog.category-tree.view. A category of any status with its path, counts, ' +
      'revision history (newest first, at most 200), the required locales it lacks, and the ' +
      'actions the caller may take on it.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiOkResponse({ type: CategoryDetailBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or catalog.categories-unavailable',
  })
  async read(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
  ): Promise<CategoryDetailBody> {
    const result = await this.getCategory.execute(context, { categoryId });
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CategoryDetailBody)
      : refusal(result.error, response, context);
    return this.settle('catalog.category-admin-get', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a category',
    description:
      `${EDITS} Created hidden, last among its siblings; Show makes it live. The default-locale ` +
      'name is required; every text passes the claim-word check and a language the check cannot ' +
      'read is refused.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryCreateRequest })
  @ApiCreatedResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.parent-not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, category.slug-taken or category.sibling-name-taken',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-create', context, response, request, body, {
      keys: ['slug', 'texts', 'treeVersion'],
      optional: ['parentId', 'seo', 'showInMenu'],
      run: (input) => this.createCategory.execute(context, input),
    });
  }

  @Patch(':categoryId')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the details of a category',
    description:
      `${EDITS} Not structural: it names the category version the admin saw. The whole content ` +
      'is sent; a locale or field left out is cleared. Saved as the next revision.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryEditDetailsRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, category.not-editable or category.sibling-name-taken',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-edit-details', context, response, request, body, {
      keys: ['version', 'texts'],
      optional: ['seo', 'showInMenu', 'imageId'],
      run: (input) => this.editDetails.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/reorder')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Move a category up or down among its siblings',
    description: `${EDITS} Swaps places with the neighbour; category.reorder-edge at the end of the list.`,
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryReorderRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, category.not-editable or category.reorder-edge',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async reorder(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-reorder', context, response, request, body, {
      keys: ['direction', 'treeVersion'],
      optional: [],
      run: (input) => this.reorderCategory.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/hide')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Hide a category',
    description:
      `${EDITS} The category and its active descendants leave the menu and the category page; ` +
      'products stay on sale. Show brings back exactly the ones this Hide hid.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryTreeVersionRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale, category.already-hidden or category.not-editable',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async hide(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-hide', context, response, request, body, {
      keys: ['treeVersion'],
      optional: [],
      run: (input) => this.hideCategory.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/show')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Show a hidden category',
    description:
      `${EDITS} Needs a name in every required language and an active parent. This is how a new ` +
      'category goes live.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryTreeVersionRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, category.not-hidden, category.parent-hidden or category.not-editable',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async show(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-show', context, response, request, body, {
      keys: ['treeVersion'],
      optional: [],
      run: (input) => this.showCategory.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/change-slug')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Change the URL name of a category',
    description:
      `${EDITS} The old URL name goes into the slug history and redirects (301); no other ` +
      'category may take it for 12 months. The new one passes the claim-word check.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryChangeSlugRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, category.slug-taken, category.slug-unchanged or category.not-editable',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: WRITE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async changeUrlName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-change-slug', context, response, request, body, {
      keys: ['slug', 'treeVersion'],
      optional: [],
      run: (input) => this.changeSlug.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/discard')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Discard a category that never went live',
    description:
      `${EDITS} Only a hidden category an admin created, never showed, with no child and no ` +
      'product revision that named it. It is archived, never deleted.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryTreeVersionRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or category.not-discardable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async discard(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-discard', context, response, request, body, {
      keys: ['treeVersion'],
      optional: [],
      run: (input) => this.discardCategory.execute(context, { ...input, categoryId }),
    });
  }

  private async write(
    msg: string,
    context: CallContext,
    response: Response,
    request: Request,
    body: unknown,
    spec: {
      readonly keys: readonly string[];
      readonly optional: readonly string[];
      readonly run: (
        input: Record<string, unknown>,
      ) => Promise<{ ok: true; value: unknown } | { ok: false; error: Refusal }>;
    },
  ): Promise<CategoryWriteWrapBody> {
    const input = closedBody(request, body, spec.keys, spec.optional);
    let outcome: CategoryWriteWrapBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await spec.run(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as CategoryWriteWrapBody)
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
