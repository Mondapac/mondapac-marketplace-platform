import { Controller, Get, Header, HttpException, Logger, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { termsTextOf } from '../domain/delivery-terms';
import type { PublishedStore } from '../domain/published-store';
import type { StoreImageRef } from '../domain/store-image';
import {
  PublishedStoreList,
  type PublishedStoreListInput,
} from '../application/use-cases/published-store-list.use-case';
import { PublishedStoreRead } from '../application/use-cases/published-store-read.use-case';
import { SellersErrorBody } from './my-file.dto';

export class StoreMoneyBody {
  @ApiProperty({ description: 'Minor units, as a decimal string.', example: '3000' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217 code.' }) currency!: string;
}

export class StoreDeliveryBody {
  @ApiProperty({ enum: ['same-day', 'next-day'] }) day!: string;
  @ApiProperty({ example: '08:00', description: "The window opens, the seller's clock." })
  from!: string;
  @ApiProperty({ example: '12:00', description: 'The window closes; 24:00 is end of day.' })
  to!: string;
  @ApiProperty({ example: '14:00', description: "Orders before this clock time (seller's clock)." })
  cutoff!: string;
}

export class PublicStoreImageBody {
  @ApiProperty({ description: 'Names the image in `GET sellers/stores/:slug/images/:id/:size`.' })
  id!: string;
  @ApiProperty({ description: 'Pixels of the `large` size.' }) width!: number;
  @ApiProperty({ description: 'Pixels of the `large` size.' }) height!: number;
}

export class PublishedStoreBody {
  @ApiProperty({ description: 'The store address part (`/s/<slug>` on the buyer site).' })
  slug!: string;
  @ApiProperty({ description: 'The public store name of the approved revision.' }) name!: string;
  @ApiProperty({
    description: 'The ServiceArea code of the store (Market configuration); never an address.',
  })
  serviceAreaCode!: string;
  @ApiProperty({ description: "The year of the first approval, in the seller's own zone." })
  sellingSince!: number;
  @ApiPropertyOptional({
    type: StoreMoneyBody,
    nullable: true,
    description:
      'null: no minimum order. Absent: it cannot be told now; show no minimum line, never "none".',
  })
  minimumOrder?: StoreMoneyBody | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The store About text in the Market default locale: plain text, never HTML, whitespace ' +
      'kept. null: none written. A store page only (absent on the list).',
  })
  about?: string | null;
  @ApiPropertyOptional({
    type: PublicStoreImageBody,
    nullable: true,
    description: 'The current logo, or null. On the list and on the store page.',
  })
  logo?: PublicStoreImageBody | null;
  @ApiPropertyOptional({
    type: PublicStoreImageBody,
    nullable: true,
    description: 'The current banner (4 to 1), or null. A store page only.',
  })
  banner?: PublicStoreImageBody | null;
  @ApiPropertyOptional({
    type: StoreDeliveryBody,
    description: 'Absent when the seller has set no delivery terms: show no delivery line.',
  })
  delivery?: StoreDeliveryBody;
}

export class PublishedStorePageBody {
  @ApiProperty({ type: [PublishedStoreBody] }) items!: PublishedStoreBody[];
  @ApiProperty({ description: 'Every store of the Market that may sell now.' }) total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

const ALLOWED = ['sort', 'page', 'pageSize'] as const;
const WHOLE_NUMBER = /^[0-9]{1,6}$/u;

const fail = (status: number, code: string, details?: object): HttpException =>
  new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);

/** The query string as the list's input; an unknown, repeated or malformed parameter is a 400. */
function listInputOf(query: Record<string, unknown>): PublishedStoreListInput {
  const fields = Object.keys(query)
    .filter((key) => !(ALLOWED as readonly string[]).includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
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
  const input = { sort: text('sort'), page: whole('page'), pageSize: whole('pageSize') };
  if (fields.length > 0) throw fail(400, 'validation.failed', { fields });
  return input;
}

const imageOf = (image: StoreImageRef | null): PublicStoreImageBody | null =>
  image === null ? null : { id: image.id, width: image.width, height: image.height };

/** The allow-listed body of one store, field by field (AC 25); Money as a string amount. */
const bodyOf = (store: PublishedStore): PublishedStoreBody => {
  const body: PublishedStoreBody = {
    slug: store.slug,
    name: store.name,
    serviceAreaCode: store.serviceAreaCode,
    sellingSince: store.sellingSince,
  };
  if (store.about !== undefined) body.about = store.about;
  if (store.logo !== undefined) body.logo = imageOf(store.logo);
  if (store.banner !== undefined) body.banner = imageOf(store.banner);
  const withTerms: PublishedStoreBody =
    store.delivery === undefined ? body : { ...body, delivery: termsTextOf(store.delivery) };
  if (store.minimumOrder === undefined) return withTerms;
  return {
    ...withTerms,
    minimumOrder:
      store.minimumOrder === null
        ? null
        : { amount: store.minimumOrder.amount.toString(), currency: store.minimumOrder.currency },
  };
};

/**
 * The public store reads of the buyer site (slice 12): the sellers page and the store page. No
 * session is read: the actor is the Market's anonymous actor and the Market is the request's. In
 * the default per-origin rate-limit class. `no-store`: whether a store may sell is checked again
 * on every call. Allow-listed public fields only (AC 25); no key is unwrapped.
 */
@ApiTags('sellers')
@RoutePopulation('customer')
@Controller('sellers/stores')
export class PublicStoreController {
  readonly #logger = new Logger('PublicStoreController');

  constructor(
    private readonly list: PublishedStoreList,
    private readonly read: PublishedStoreRead,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The stores that sell now (public)',
    description:
      'No session needed. Stores that may sell now in the request Market, sorted by `name` ' +
      '(default) or `newest` (first approval), ties by slug. `page` 1 to 100, `pageSize` 1 to ' +
      '48 (default 24).',
  })
  @ApiQuery({ name: 'sort', required: false, enum: ['name', 'newest'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiOkResponse({ type: PublishedStorePageBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async stores(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
  ): Promise<PublishedStorePageBody> {
    const result = await this.list.execute(context, listInputOf(query));
    if (result.ok) {
      return { ...result.value, items: result.value.items.map(bodyOf) };
    }
    const { error } = result;
    if (error.code === 'validation.failed') throw fail(400, error.code, { fields: error.fields });
    throw this.#refused(context, error.code);
  }

  @Get(':slug')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'One store that sells now (public)',
    description:
      'No session needed. An unknown, malformed or retired slug and a store that may not sell ' +
      'now all answer 404 sellers.store-not-found, alike.',
  })
  @ApiOkResponse({ type: PublishedStoreBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'sellers.store-not-found' })
  @ApiTooManyRequestsResponse({ description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async store(
    @Call() context: CallContext,
    @Param('slug') slug: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PublishedStoreBody> {
    const unknown = Object.keys(query).sort().slice(0, 10);
    if (unknown.length > 0) {
      throw fail(400, 'validation.failed', {
        fields: unknown.map((key) => ({
          path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
          code: 'unknown-field',
        })),
      });
    }
    const result = await this.read.execute(context, { slug });
    if (result.ok) return bodyOf(result.value);
    if (result.error.code === 'sellers.store-not-found') throw fail(404, result.error.code);
    throw this.#refused(context, result.error.code);
  }

  #refused(context: CallContext, code: string): HttpException {
    const denied = ACCESS_DENIED_STATUS[code as keyof typeof ACCESS_DENIED_STATUS];
    if (denied !== undefined) return fail(denied, code);
    this.#logger.warn({
      msg: 'sellers.public-store-refused',
      code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(503, 'sellers.unavailable');
  }
}
