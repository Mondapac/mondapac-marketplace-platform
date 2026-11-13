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
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
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
  ApiPayloadTooLargeResponse,
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
import { CategoryMove } from '../application/use-cases/category-move.use-case';
import { CategoryMerge } from '../application/use-cases/category-merge.use-case';
import { CategoryArchive } from '../application/use-cases/category-archive.use-case';
import { CategoryReorder } from '../application/use-cases/category-reorder.use-case';
import { CategoryShow } from '../application/use-cases/category-show.use-case';
import { CategoryAdminGet } from '../application/use-cases/category-admin-get.use-case';
import { CategoryAdminTree } from '../application/use-cases/category-admin-tree.use-case';
import { CategoryImpact } from '../application/use-cases/category-impact.use-case';
import { CategoryImageRead } from '../application/use-cases/category-image-read.use-case';
import { CategoryImageRemove } from '../application/use-cases/category-image-remove.use-case';
import { CategoryImageSet } from '../application/use-cases/category-image-set.use-case';
import {
  CategoryChangeSlugRequest,
  CategoryCreateRequest,
  CategoryDetailBody,
  CategoryEditDetailsRequest,
  CategoryImageSetRequest,
  CategoryImageWriteBody,
  CategoryImpactBody,
  CategoryReorderRequest,
  CategoryTreeBody,
  CategoryArchiveRequest,
  CategoryMergeRequest,
  CategoryMoveRequest,
  CategoryTreeVersionRequest,
  CategoryVersionRequest,
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
  'image.not-found': 404,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.too-many-pixels': 422,
  'file.too-small': 422,
  'file.unreadable': 422,
  'category.target-not-found': 404,
  'category.move-unchanged': 409,
  'category.cycle': 422,
  'category.has-subcategories': 409,
  'category.only-platform-category': 422,
  'category.products-on-upper-level': 422,
  'category.impact-too-large': 422,
  'category.referenced-by-policy': 409,
  'category.check-unavailable': 503,
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

/**
 * The image upload arrives as bytes (its body parser takes a larger limit than the JSON one, see
 * `configure-app.ts`); anything that is not a JSON object stays as it is and `closedBody` refuses it.
 */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const CATEGORY_PARAM = { name: 'categoryId', description: 'The category. A UUID v7.' };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const EDITS =
  'Needs catalog.category-tree.edit; refused in an acting-as session. A structural write names ' +
  'the tree version the page read (`conflict.stale` when another admin changed the tree).';
const RESTRUCTURES =
  'Needs the protected key catalog.category-tree.restructure; refused in an acting-as session. ' +
  'Names the tree version the page read and a reason note. Certificate rules are checked first.';
const RESTRUCTURE_409 =
  'conflict.stale, category.not-editable, category.move-unchanged, category.has-subcategories, ' +
  'category.sibling-name-taken (details.fields) or category.referenced-by-policy (details.typeCodes)';
const RESTRUCTURE_422 =
  'category.cycle, category.depth-exceeded (details.max), category.products-on-upper-level or ' +
  'category.only-platform-category (details.total), category.impact-too-large (details.max)';
const RESTRUCTURE_503 = 'category.check-unavailable or access.unavailable';
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
    private readonly setImage: CategoryImageSet,
    private readonly removeImage: CategoryImageRemove,
    private readonly readImage: CategoryImageRead,
    private readonly moveCategory: CategoryMove,
    private readonly mergeCategory: CategoryMerge,
    private readonly archiveCategory: CategoryArchive,
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
      'may do on the page. Each row carries its effective feature set (own or inherited from the ' +
      'nearest ancestor that holds one); `featureSetId` keeps only the rows that end up with it.',
  })
  @ApiQuery({
    name: 'featureSetId',
    required: false,
    description: 'Only the categories whose effective feature set is this one. A UUID.',
  })
  @ApiOkResponse({ type: CategoryTreeBody })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields): an unknown query key or a malformed id',
  })
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
    const result = await this.tree.execute(context, query);
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
      'Offers and Offers with an active certification tag; with `targetId`, the products whose ' +
      'feature set would change. Advisory: a change re-checks its own ' +
      'guards. Bounded at 10 seconds; `complete: false` means "at least".',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiQuery({ name: 'action', required: true, enum: ['move', 'merge', 'archive'] })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description:
      'Move: the new parent id, or `top` for a department; merge: the target id. Adds ' +
      '`featureSetChanges`. Not taken with archive.',
  })
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
    @Query('targetId') targetId: unknown,
  ): Promise<CategoryImpactBody> {
    const result = await this.impact.execute(context, {
      categoryId,
      action,
      ...(targetId === undefined ? {} : { targetId: targetId === 'top' ? null : targetId }),
    });
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

  @Get(':categoryId/images/:imageId/:size')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @ApiOperation({
    summary: 'Read one rendition of a category image',
    description:
      'Needs catalog.category-tree.view. Any status. `size` is thumb, medium or large; `imageId` ' +
      "is the category's current image. The answer is an image/jpeg written by the server.",
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiParam({ name: 'imageId', format: 'uuid' })
  @ApiParam({ name: 'size', enum: ['thumb', 'medium', 'large'] })
  @ApiOkResponse({ description: 'image/jpeg bytes' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'image.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async readImageFile(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Param('imageId') imageId: string,
    @Param('size') size: string,
  ): Promise<StreamableFile> {
    const result = await this.readImage.execute(context, { categoryId, imageId, size });
    const outcome = result.ok
      ? new StreamableFile(result.value.bytes, { type: result.value.contentType })
      : refusal(result.error, response, context);
    return this.settle('catalog.category-image-read', context, outcome);
  }

  @Put(':categoryId/image')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Set or replace the image of a category',
    description:
      'Needs catalog.category-tree.edit; refused in an acting-as session. Names the category ' +
      'version the admin saw. The picture is decoded and written again as three metadata-free ' +
      'JPEG renditions; the upload itself is not kept. The old image is removed. Not structural.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryImageSetRequest })
  @ApiOkResponse({ type: CategoryImageWriteBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or category.not-editable',
  })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'file.too-small, file.too-many-pixels or file.unreadable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'file.unsupported-type' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async putImage(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryImageWriteBody> {
    return this.write('catalog.category-image-set', context, response, request, jsonOf(body), {
      keys: ['version', 'data'],
      optional: [],
      run: (input) => this.setImage.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/image/remove')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Remove the image of a category',
    description:
      'Needs catalog.category-tree.edit; refused in an acting-as session. Names the category ' +
      'version the admin saw. A category with no image answers as it is. Not structural.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryVersionRequest })
  @ApiOkResponse({ type: CategoryImageWriteBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'conflict.stale or category.not-editable',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async postRemoveImage(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryImageWriteBody> {
    return this.write('catalog.category-image-remove', context, response, request, body, {
      keys: ['version'],
      optional: [],
      run: (input) => this.removeImage.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/move')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Move a category under a new parent',
    description:
      `${RESTRUCTURES} The category and its subcategories go under the new parent (null: a ` +
      'department), last among its children. Badges under it are checked again.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryMoveRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'category.not-found or category.parent-not-found',
  })
  @ApiConflictResponse({ type: ApiErrorBody, description: RESTRUCTURE_409 })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: RESTRUCTURE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: RESTRUCTURE_503 })
  async move(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-move', context, response, request, body, {
      keys: ['treeVersion', 'parentId', 'reason'],
      optional: [],
      run: (input) => this.moveCategory.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/merge')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Merge a category into another',
    description:
      `${RESTRUCTURES} Its subcategories move to the target; its products and old address now ` +
      'resolve to the target. Badges under it are checked again.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryMergeRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: ApiErrorBody,
    description: 'category.not-found or category.target-not-found',
  })
  @ApiConflictResponse({ type: ApiErrorBody, description: RESTRUCTURE_409 })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: RESTRUCTURE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: RESTRUCTURE_503 })
  async merge(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-merge', context, response, request, body, {
      keys: ['treeVersion', 'targetId', 'reason'],
      optional: [],
      run: (input) => this.mergeCategory.execute(context, { ...input, categoryId }),
    });
  }

  @Post(':categoryId/archive')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Archive a category',
    description:
      `${RESTRUCTURES} Terminal: there is no restore (Hide pauses a category). Only a category ` +
      'with no live subcategory, and never one that is the only category of a live product.',
  })
  @ApiParam(CATEGORY_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: CategoryArchiveRequest })
  @ApiOkResponse({ type: CategoryWriteWrapBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'category.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: RESTRUCTURE_409 })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: RESTRUCTURE_422 })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: RESTRUCTURE_503 })
  async archive(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryWriteWrapBody> {
    return this.write('catalog.category-archive', context, response, request, body, {
      keys: ['treeVersion', 'reason'],
      optional: [],
      run: (input) => this.archiveCategory.execute(context, { ...input, categoryId }),
    });
  }

  private async write<T extends object = CategoryWriteWrapBody>(
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
  ): Promise<T> {
    const input = closedBody(request, body, spec.keys, spec.optional);
    let outcome: T | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await spec.run(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as T)
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
