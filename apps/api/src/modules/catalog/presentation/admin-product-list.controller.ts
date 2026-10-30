import { Controller, Get, Header, HttpException, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
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
import {
  ADMIN_PRODUCT_SORTS,
  ADMIN_PRODUCT_VIEWS,
  AdminProductsList,
  LISTED_STATUSES,
} from '../application/use-cases/admin-products-list.use-case';
import { PRODUCT_SCOPES } from '../domain/product';
import { AdminProductListDto } from './admin-product-list.dto';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of the admin product list (catalog design 8.2, 9.2). */
export const ADMIN_PRODUCT_LIST_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.unavailable': 503,
});

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NUMBER = /^\d{1,4}$/;

/** The query as the use case reads it: `page` and `pageSize` become numbers (or -1: refused). */
function listQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined)
      out[key] = typeof value === 'string' && NUMBER.test(value) ? Number(value) : -1;
  }
  return out;
}

/**
 * The marketplace product list of the admin Catalogue page over HTTP (catalog design 8.2, 9.2):
 * a read of the admin session. A thin adapter: one use case does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/products')
export class AdminProductListController {
  readonly #logger = new Logger('AdminProductListController');

  constructor(private readonly list: AdminProductsList) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the products of the Market, platform and seller scope',
    description:
      'Needs catalog.product.view. `view` is a tab: active (published), inactive (unpublished ' +
      'and withdrawn) or all (every status but draft and discarded); default active. `q` matches ' +
      'a part of the name (Market default locale) or of the product code. Filters: scope, ' +
      'status, categoryId, typeCode, sellerId. `sort` is name, updated or created (default ' +
      'updated), `direction` asc or desc (default asc for name, desc otherwise). `page` is 1 to ' +
      '1000 and `pageSize` 1 to 100 (default 25). `counts` holds the three tab counts for the ' +
      'same search and filters. Sorting by name over more than 5000 matches is refused with ' +
      'validation.failed (sort, too-broad). No price and no stock.',
  })
  @ApiQuery({ name: 'view', required: false, enum: ADMIN_PRODUCT_VIEWS })
  @ApiQuery({ name: 'q', required: false, description: 'Up to 100 characters.' })
  @ApiQuery({ name: 'scope', required: false, enum: PRODUCT_SCOPES })
  @ApiQuery({ name: 'status', required: false, enum: LISTED_STATUSES })
  @ApiQuery({ name: 'categoryId', required: false, description: 'A platform category id.' })
  @ApiQuery({ name: 'typeCode', required: false, description: 'A product type code.' })
  @ApiQuery({ name: 'sellerId', required: false, description: 'The owning seller id.' })
  @ApiQuery({ name: 'sort', required: false, enum: ADMIN_PRODUCT_SORTS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: '1 to 1000, default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100, default 25.' })
  @ApiOkResponse({ type: AdminProductListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async products(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminProductListDto> {
    const result = await this.list.execute(context, listQuery(query));
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as AdminProductListDto)
      : refusalWith(ADMIN_PRODUCT_LIST_STATUS, result.error, response, context);
    const failed = !result.ok && result.error.code === 'access.unavailable';
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.admin-products-list',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
