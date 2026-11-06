import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { CATEGORY_SLUG } from '../domain/category-edit';
import { CategorySlugResolveQuery } from '../application/use-cases/category-slug-resolve.use-case';
import { PublicCategoryTreeQuery } from '../application/use-cases/public-category-tree.use-case';
import { fail } from './http-answers';

/** A locale tag as the buyer site sends it (`en-AU`, `fa-IR`); anything else is refused. */
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/u;
/** Longer than any slug the editor accepts (80); a longer one is not found without a read. */
const SLUG_MAX = 120;

export class CategorySeoBody {
  @ApiProperty({ nullable: true, type: String, description: 'At most 60 characters.' })
  title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'At most 160 characters.' })
  description!: string | null;
  @ApiProperty() noindex!: boolean;
}

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
  @ApiProperty({
    description:
      "The place among its live siblings, from 0 (the admin's order, then name, then id).",
  })
  position!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'In `locale`, else in `defaultLocale`; null when neither has one.',
  })
  shortDescription!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The category image; null until the category image package (C3c) stores one.',
  })
  imageUrl!: string | null;
  @ApiProperty({ type: CategorySeoBody, description: 'English only.' }) seo!: CategorySeoBody;
  @ApiProperty({ description: "The admin's Show in menu switch for this category alone." })
  showInMenu!: boolean;
  @ApiProperty({
    description:
      'A product with a listed Offer is on this category or a live category below it (decision 11).',
  })
  hasLiveProducts!: boolean;
  @ApiProperty({
    description:
      'Products with a listed Offer on this category or below it, summed from each category, so a ' +
      'product on two categories of one branch counts twice there. A guide for the filter, not a ' +
      'search total.',
  })
  liveProductCount!: number;
  @ApiProperty({
    description:
      'Shown in menus and the sitemap: showInMenu, hasLiveProducts and its parent is in the menu. ' +
      'A row with false is kept so its page still resolves.',
  })
  inMenu!: boolean;
}

export class CategoryTreeBody {
  @ApiProperty({
    description:
      'The locale names are in: the asked one if the Market supports it, else the default.',
  })
  locale!: string;
  @ApiProperty({ description: "The Market's default locale (the fallback of every text)." })
  defaultLocale!: string;
  @ApiProperty({
    type: [LiveCategoryBody],
    description: 'Depth first: each category is followed by its children, in sibling order.',
  })
  categories!: LiveCategoryBody[];
}

export class CategoryResolveBody {
  @ApiProperty({ enum: ['category', 'redirect'] }) kind!: 'category' | 'redirect';
  @ApiProperty({
    format: 'uuid',
    required: false,
    description: 'kind category: the live category the slug names.',
  })
  id?: string;
  @ApiProperty({
    description:
      'kind category: the slug asked. kind redirect: the slug to send the buyer to, always a ' +
      'slug (lower-case letters, digits, hyphens), never a URL; one hop, chains already followed.',
  })
  slug!: string;
  @ApiProperty({
    required: false,
    description:
      'kind redirect: true answers 301 (retired slug, merge, archive), false 302 (hidden).',
  })
  permanent?: boolean;
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

  constructor(
    private readonly tree: PublicCategoryTreeQuery,
    private readonly resolver: CategorySlugResolveQuery,
  ) {}

  @Get('categories')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The live category tree (public)',
    description:
      'No session needed. Active platform categories only, each under its nearest live ' +
      'ancestor (a merged one is followed, an archived one skipped), in the admin order. ' +
      'Optional `locale`: names and short descriptions in it, falling back to the default locale.',
  })
  @ApiQuery({ name: 'locale', required: false, type: String })
  @ApiOkResponse({ type: CategoryTreeBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'catalog.categories-unavailable' })
  async categories(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<CategoryTreeBody> {
    refuseUnknown(query, ['locale']);
    const locale = query['locale'];
    if (locale !== undefined && (typeof locale !== 'string' || !LOCALE.test(locale))) {
      throw fail(400, 'validation.failed', { fields: [{ path: 'locale', code: 'invalid' }] });
    }
    const result = await this.tree.execute(context, locale === undefined ? {} : { locale });
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

  @Get('categories/resolve')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'What a buyer category URL shows (public)',
    description:
      'No session needed. `slug` names a live category (kind category), or one to redirect to ' +
      '(kind redirect: slug history, merges and archives permanent, a hidden category ' +
      'temporary to its nearest shown ancestor), else 404 catalog.category-not-found. Another ' +
      "Market's slug is not found too.",
  })
  @ApiQuery({ name: 'slug', required: true, type: String })
  @ApiOkResponse({ type: CategoryResolveBody })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiNotFoundResponse({ description: 'catalog.category-not-found' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ description: 'catalog.categories-unavailable' })
  async resolve(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<CategoryResolveBody> {
    refuseUnknown(query, ['slug']);
    const slug = query['slug'];
    if (typeof slug !== 'string' || slug.length === 0) {
      throw fail(400, 'validation.failed', { fields: [{ path: 'slug', code: 'required' }] });
    }
    // Not a slug (or longer than any): not found before any read, so junk costs nothing.
    if (slug.length > SLUG_MAX || !CATEGORY_SLUG.test(slug)) {
      throw fail(404, 'catalog.category-not-found');
    }
    const result = await this.resolver.execute(context, { slug });
    if (result.ok) {
      const answer = result.value;
      return answer.kind === 'category'
        ? { kind: 'category', id: answer.id, slug: answer.slug }
        : { kind: 'redirect', slug: answer.slug, permanent: answer.permanent };
    }
    if (result.error.code === 'catalog.category-not-found') {
      throw fail(404, 'catalog.category-not-found');
    }
    const denied = ACCESS_DENIED_STATUS[result.error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) throw fail(denied, result.error.code);
    this.#logger.warn({
      msg: 'catalog.category-resolve-refused',
      code: result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    throw fail(503, 'catalog.categories-unavailable');
  }
}

/** A query with a parameter the route does not take is refused (at most 10 named). */
function refuseUnknown(query: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(query)
    .filter((key) => !allowed.includes(key))
    .sort()
    .slice(0, 10);
  if (unknown.length > 0) {
    throw fail(400, 'validation.failed', {
      fields: unknown.map((key) => ({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
        code: 'unknown-field',
      })),
    });
  }
}
