import { Controller, Get, Header, Logger, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { PublicBrandQuery } from '../application/use-cases/public-brand.use-case';
import { PublicBrandsAzQuery } from '../application/use-cases/public-brands-az.use-case';
import { PublicBrandAzBody, PublicBrandBody } from './brand.dto';
import { fail } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

const noQuery = (query: Record<string, unknown>): void => {
  const unknown = Object.keys(query).sort().slice(0, 10);
  if (unknown.length > 0) {
    throw fail(400, 'validation.failed', {
      fields: unknown.map((key) => ({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
        code: 'unknown-field',
      })),
    });
  }
};

/**
 * The public brand pages (catalog brand package; storefront B5): a brand by slug with its live
 * product count, and the A to Z list. No session is read; the Market is the request's. In the
 * default per-origin rate-limit class. `no-store`, like the category tree: the count is read again on
 * every call. Only ACTIVE brands answer.
 */
@ApiTags('catalog')
@RoutePopulation('customer')
@Controller('catalog/brands')
export class PublicBrandController {
  readonly #logger = new Logger('PublicBrandController');

  constructor(
    private readonly brandBySlug: PublicBrandQuery,
    private readonly brandsAz: PublicBrandsAzQuery,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The brands A to Z (public)',
    description:
      'No session needed. Active brands only, in sections A to Z (then #), by name inside a ' +
      'section. No query parameters.',
  })
  @ApiOkResponse({ type: PublicBrandAzBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'brand.unavailable' })
  async list(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<PublicBrandAzBody> {
    noQuery(query);
    const result = await this.brandsAz.execute(context, {});
    if (result.ok) return JSON.parse(JSON.stringify(result.value)) as PublicBrandAzBody;
    throw this.refused('catalog.brands-refused', context, result.error.code);
  }

  @Get(':slug')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A brand by slug (public)',
    description:
      'No session needed. An active brand with the number of its products that are live in the ' +
      "request's Market (published, with an Offer on sale). A draft, an archived or an unknown " +
      'slug is brand.not-found.',
  })
  @ApiParam({ name: 'slug', description: 'The brand slug, lower case words joined by hyphens.' })
  @ApiOkResponse({ type: PublicBrandBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'brand.not-found' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'brand.unavailable' })
  async read(
    @Call() context: CallContext,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PublicBrandBody> {
    noQuery(query);
    const result = await this.brandBySlug.execute(context, { slug });
    if (result.ok) return JSON.parse(JSON.stringify(result.value)) as PublicBrandBody;
    throw this.refused('catalog.brand-refused', context, result.error.code);
  }

  private refused(msg: string, context: CallContext, code: string) {
    const denied = ACCESS_DENIED_STATUS[code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) return fail(denied, code);
    if (code === 'brand.not-found') return fail(404, 'brand.not-found');
    this.#logger.warn({
      msg,
      code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(503, 'brand.unavailable');
  }
}
