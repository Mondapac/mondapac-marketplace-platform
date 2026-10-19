import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { CategoryTreeQuery } from '../application/use-cases/category-tree.use-case';
import { fail } from './http-answers';

export class LiveCategoryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The nearest live ancestor; null at the top level.',
  })
  parentId!: string | null;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The name in `locale`, else in another locale of the category.' })
  name!: string;
  @ApiProperty({ description: '0 at the top level.' }) depth!: number;
  @ApiProperty({ description: 'The place among its siblings, from 0 (by name, then id).' })
  position!: number;
}

export class CategoryTreeBody {
  @ApiProperty({ description: "The Market's default locale." }) locale!: string;
  @ApiProperty({
    type: [LiveCategoryBody],
    description: 'Depth first: each category is followed by its children, in sibling order.',
  })
  categories!: LiveCategoryBody[];
}

/**
 * The public platform category tree (storefront reads package): the buyer site's left menu and
 * Browse drawer. No session is read; the Market is the request's. In the default per-origin
 * rate-limit class. `no-store`, like search: the tree is read again on every call.
 */
@ApiTags('catalog')
@RoutePopulation('customer')
@Controller('catalog')
export class PublicCategoryController {
  readonly #logger = new Logger('PublicCategoryController');

  constructor(private readonly tree: CategoryTreeQuery) {}

  @Get('categories')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The live category tree (public)',
    description:
      'No session needed. Active platform categories only, each under its nearest live ' +
      'ancestor (a merged one is followed, an archived one skipped). No query parameters.',
  })
  @ApiOkResponse({ type: CategoryTreeBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'catalog.categories-unavailable' })
  async categories(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<CategoryTreeBody> {
    const unknown = Object.keys(query).sort().slice(0, 10);
    if (unknown.length > 0) {
      throw fail(400, 'validation.failed', {
        fields: unknown.map((key) => ({
          path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
          code: 'unknown-field',
        })),
      });
    }
    const result = await this.tree.execute(context, {});
    if (result.ok) return JSON.parse(JSON.stringify(result.value)) as CategoryTreeBody;
    const denied = ACCESS_DENIED_STATUS[result.error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, result.error.code);
    this.#logger.warn({
      msg: 'catalog.categories-refused',
      code: result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'catalog.categories-unavailable');
  }
}
