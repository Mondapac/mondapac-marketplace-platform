import { Controller, Get, Header, HttpException, Logger, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import type { SearchProductsRequest } from '../domain/search-query';
import { SearchProducts } from '../application/use-cases/search-products.use-case';
import { ProductSearchPageBody } from './search.dto';

const ALLOWED = ['q', 'category', 'store', 'brand', 'page', 'pageSize'] as const;
const WHOLE_NUMBER = /^[0-9]{1,6}$/u;

const fail = (status: number, code: string, details?: object): HttpException =>
  new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);

/**
 * Turns the query string into a request. A parameter that is not a single string, a number that
 * is not a whole number and any other parameter name are `validation.failed` (400).
 */
function requestOf(query: Record<string, unknown>): SearchProductsRequest {
  const unknown = Object.keys(query)
    .filter((key) => !(ALLOWED as readonly string[]).includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  const fields = [...unknown];
  const text = (name: (typeof ALLOWED)[number]): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      fields.push({ path: name, code: 'type' });
      return undefined;
    }
    return value;
  };
  const whole = (name: 'page' | 'pageSize'): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    if (!WHOLE_NUMBER.test(value)) {
      fields.push({ path: name, code: 'range' });
      return undefined;
    }
    return Number(value);
  };
  const request = {
    q: text('q'),
    category: text('category'),
    store: text('store'),
    brand: text('brand'),
    page: whole('page'),
    pageSize: whole('pageSize'),
  };
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return request;
}

/**
 * The storefront product search (speed mode, Phase 6 package 2). No session is read: the actor is
 * the Market's anonymous actor and the Market is the request's. In the default rate-limit class
 * (per origin, from the Market's `requestLimits`). Not cacheable: the answer is re-checked against
 * catalog and sellers on every call.
 */
@ApiTags('search')
@RoutePopulation('customer')
@Controller('search')
export class SearchController {
  readonly #logger = new Logger('SearchController');

  constructor(private readonly search: SearchProducts) {}

  @Get('products')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Search products (public)',
    description:
      'No session needed. `q` is 2 to 100 characters, in web-search syntax; with a `category` and ' +
      'no `q` the route lists that category by name; with a `store` (a store address) and no `q` it lists the Offers of that store by name, in one category if `category` is also given, and an unknown, retired or not-selling store answers an empty page. Text matches are ranked, ties by Offer id, ' +
      'so pages are stable. `pageSize` is 1 to 48 (default 24), `page` 1 to 100. Only Offers ' +
      'that are sellable now and whose seller may sell are returned.',
  })
  @ApiQuery({ name: 'q', required: false, description: '2 to 100 characters.' })
  @ApiQuery({ name: 'category', required: false, description: 'A platform category id.' })
  @ApiQuery({
    name: 'store',
    required: false,
    description: 'A store address (slug), 3 to 50 characters. Not with `q`.',
  })
  @ApiQuery({
    name: 'brand',
    required: false,
    description:
      'A brand address (slug), at most 80 characters. Lists the Offers of that brand by name ' +
      '(up to its first 1000 live products); not with `q` or `store`; may combine with ' +
      '`category`. An unknown, draft or archived brand answers an empty page.',
  })
  @ApiQuery({ name: 'page', required: false, description: '1 to 100, default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 48, default 24.' })
  @ApiOkResponse({ type: ProductSearchPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async products(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductSearchPageBody> {
    const result = await this.search.execute(context, requestOf(query));
    if (result.ok) return JSON.parse(JSON.stringify(result.value)) as ProductSearchPageBody;
    const { error } = result;
    if (error.code === 'validation.failed') {
      throw fail(400, error.code, { fields: error.fields });
    }
    const denied = ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, error.code);
    this.#logger.warn({
      msg: 'search.refused',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'search.unavailable');
  }
}
