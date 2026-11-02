import { Controller, Get, Header, HttpException, Logger, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
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
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CategoryAdminGet } from '../application/use-cases/category-admin-get.use-case';
import { CategoryAdminTree } from '../application/use-cases/category-admin-tree.use-case';
import { CategoryImpact } from '../application/use-cases/category-impact.use-case';
import { CategoryDetailBody, CategoryImpactBody, CategoryTreeBody } from './category-admin.dto';
import { refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the admin category read routes (categories package C1). A
 * malformed request is 400; an unknown, malformed or other-Market category id is 404 with the same
 * body; a tree that cannot be built is 503, like a missing dependency.
 */
export const CATEGORY_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'category.not-found': 404,
  'catalog.categories-unavailable': 503,
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
