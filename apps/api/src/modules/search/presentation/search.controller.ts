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
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import type { SearchProductsRequest } from '../domain/search-query';
import { SearchProducts } from '../application/use-cases/search-products.use-case';
import { SearchStores } from '../application/use-cases/search-stores.use-case';
import { SuggestSearch } from '../application/use-cases/suggest-search.use-case';
import { ProductSearchPageBody, StoreSearchPageBody, SuggestBody } from './search.dto';

const ALLOWED = [
  'q',
  'category',
  'direct',
  'store',
  'brand',
  'sort',
  'filter',
  'range',
  'price',
  'page',
  'pageSize',
] as const;
const STORE_ALLOWED = ['q', 'page', 'pageSize'] as const;
const SUGGEST_ALLOWED = ['q'] as const;
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
  /** A parameter that may repeat: one string or a list of strings. */
  const list = (name: 'filter' | 'range'): string | string[] | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value;
    }
    fields.push({ path: name, code: 'type' });
    return undefined;
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
    direct: text('direct'),
    store: text('store'),
    brand: text('brand'),
    sort: text('sort'),
    filter: list('filter'),
    range: list('range'),
    price: text('price'),
    page: whole('page'),
    pageSize: whole('pageSize'),
  };
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return request;
}

/** Turns the query string of the store search into a request (the same rules as `requestOf`). */
function storesRequestOf(query: Record<string, unknown>): {
  q: string | undefined;
  page: number | undefined;
  pageSize: number | undefined;
} {
  const fields = Object.keys(query)
    .filter((key) => !(STORE_ALLOWED as readonly string[]).includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  const text = (name: (typeof STORE_ALLOWED)[number]): string | undefined => {
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
  const request = { q: text('q'), page: whole('page'), pageSize: whole('pageSize') };
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return request;
}

/** Turns the query string of the suggest route into a request (the same rules as `requestOf`). */
function suggestRequestOf(query: Record<string, unknown>): { q: string | undefined } {
  const fields = Object.keys(query)
    .filter((key) => !(SUGGEST_ALLOWED as readonly string[]).includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  const q = query['q'];
  if (q !== undefined && typeof q !== 'string') fields.push({ path: 'q', code: 'type' });
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return { q: q as string | undefined };
}

/**
 * The storefront product search (speed mode, Phase 6 package 2). No session is read: the actor is
 * the Market's anonymous actor and the Market is the request's. In its own per-origin rate-limit
 * class `public-search` (Market `requestLimits.publicSearchPerMinute`; Hassan L-3 on search 1a),
 * because a text search also counts its whole scope. Not cacheable: the answer is re-checked
 * against catalog and sellers on every call.
 */
@ApiTags('search')
@RoutePopulation('customer')
@RateLimit('public-search')
@Controller('search')
export class SearchController {
  readonly #logger = new Logger('SearchController');

  constructor(
    private readonly search: SearchProducts,
    private readonly searchStores: SearchStores,
    private readonly suggest: SuggestSearch,
  ) {}

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
    name: 'direct',
    required: false,
    enum: ['true'],
    description:
      '`true` lists only the products on `category` itself, not on a category below it (the ' +
      'buyer site\'s "Other {name}" filter). Needs `category`.',
  })
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
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['relevance', 'top-rated'],
    description:
      '`relevance` (default). `top-rated` orders by the Bayesian average of the product stars, ' +
      'then by relevance; it exists only while the Market has the search rating boost on ' +
      '(`search.ratingBoost`, off by default) and is `validation.failed` otherwise. Not with ' +
      '`store` or `brand`. While the boost is on, `relevance` is also nudged by the ratings, ' +
      'by 10 % at most.',
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    description:
      'Attribute filters, one parameter per attribute: `<attribute>:<code>[,<code>...]` with option ' +
      'codes (never labels). Values of one attribute are OR-ed, attributes are AND-ed. A yes switch is ' +
      '`<attribute>:true`. On a category list the attributes are the filters the admin chose for ' +
      'the category; on a text search they are `brand` (brand address) and `country-of-origin` (a ' +
      'lower case ISO 3166-1 code). An attribute that is not a filter of the listing is ignored. ' +
      'Up to 8; not with `store` or `brand`. A filtered page has `filtered: true` and is not for ' +
      'search engines (`noindex`, canonical to the category).',
  })
  @ApiQuery({
    name: 'range',
    required: false,
    description:
      'Number ranges, one parameter per attribute: `<attribute>:<min>..<max>` (either end may be ' +
      'left out). Up to 3; same rules as `filter`.',
  })
  @ApiQuery({
    name: 'price',
    required: false,
    description:
      'Price filter: `<min>..<max>` in the Market currency minor units (either end may be left ' +
      'out). A product matches when one of its variants that matches the other filters is in ' +
      'stock at a price within it; the item `price` then reads those variants only. Not with ' +
      '`store` or `brand`. A priced page is `filtered`.',
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
    if (result.ok) {
      // Money amounts are bigint: written as decimal text (JSON has no bigint).
      return JSON.parse(
        JSON.stringify(result.value, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ) as ProductSearchPageBody;
    }
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

  @Get('stores')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Search stores by name (public)',
    description:
      'No session needed. `q` is 2 to 100 characters, in web-search syntax (at most 8 `or` terms). ' +
      'Lists public stores (an approved revision, a held address, the seller may sell now) whose ' +
      'name matches and that have at least one sellable Offer, in rank order, ties by seller. ' +
      "`pageSize` is 1 to 48 (default 24), `page` 1 to 100. `productCount` counts the store's " +
      'indexed Offers.',
  })
  @ApiQuery({ name: 'q', required: true, description: '2 to 100 characters.' })
  @ApiQuery({ name: 'page', required: false, description: '1 to 100, default 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 48, default 24.' })
  @ApiOkResponse({ type: StoreSearchPageBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async stores(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<StoreSearchPageBody> {
    const result = await this.searchStores.execute(context, storesRequestOf(query));
    if (result.ok) return result.value as StoreSearchPageBody;
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

  /**
   * In `default`, not the controller's `public-search`: it is called once per keystroke, so sharing
   * the search's lower budget would throttle the search itself. Its own class is a follow-up.
   */
  @Get('suggest')
  @RateLimit('default')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Header search suggestions (public)',
    description:
      'No session needed. `q` of fewer than 2 characters answers 200 with empty lists and `total` 0; ' +
      'at most 100 characters and 8 words. Every typed word must match (product name, store name or ' +
      'category), the last one as a prefix. Products (at most 5, one per product) are ordered: name ' +
      'starts with the query, name contains it, then seller or category matches; stores (at most 3) ' +
      'the same way. No price and no certification text. Only Offers that are sellable now and ' +
      'whose seller may sell are shown (the same re-check as `/search/products`); the index ' +
      'side is cached for a few seconds per Market and query. Unknown parameters are `validation.failed`.',
  })
  @ApiQuery({ name: 'q', required: false, description: '2 to 100 characters.' })
  @ApiOkResponse({ type: SuggestBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'search.unavailable' })
  async suggestions(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<SuggestBody> {
    const result = await this.suggest.execute(context, suggestRequestOf(query));
    if (result.ok) return result.value;
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
