import { Body, Controller, Get, HttpCode, Logger, Put, Query, Req, Res } from '@nestjs/common';
import { RequiresStepUp } from '../../../platform/authz';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  MAX_MINIMUM_ORDER_HISTORY_PAGE,
  MINIMUM_ORDER_HISTORY_PAGE,
  StoreSettingsMinimumOrderHistory,
  type MinimumOrderChangeView,
  type MinimumOrderHistoryInput,
} from '../application/use-cases/store-settings-minimum-order-history.use-case';
import {
  StoreSettingsRead,
  type StoreSettingsView,
} from '../application/use-cases/store-settings-read.use-case';
import { StoreSettingsSaveMinimumOrder } from '../application/use-cases/store-settings-save-minimum-order.use-case';
import { errorOf, fail, type MyFileError } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { parseMinimumOrderBody, type MinimumOrderBody } from './store-settings.body';

export class MinimumOrderAmountBody {
  @ApiProperty({ description: 'Minor units of the Market currency, a whole number above zero.' })
  amount!: number;

  @ApiProperty({ description: "ISO 4217: the Market's currency." })
  currency!: string;
}

export class SaveMinimumOrderRequest {
  @ApiProperty({ description: 'The version the settings were read at (stale: conflict.stale).' })
  expectedVersion!: number;

  @ApiProperty({
    type: MinimumOrderAmountBody,
    nullable: true,
    description: 'The minimum order, or null for no minimum (any amount).',
  })
  minimumOrder!: MinimumOrderAmountBody | null;
}

export class StoreSettingsBody {
  @ApiProperty({ description: 'Name this as expectedVersion in the next save.' })
  version!: number;

  @ApiProperty({ type: MinimumOrderAmountBody, nullable: true })
  minimumOrder!: MinimumOrderAmountBody | null;

  @ApiProperty({ description: "The Market's currency a minimum is entered in." })
  currency!: string;

  @ApiProperty({ description: 'The largest amount, in minor units of that currency.' })
  maximumAmount!: number;
}

export class MinimumOrderChangeRoleBody {
  @ApiProperty({ enum: ['system', 'default', 'custom'] })
  kind!: 'system' | 'default' | 'custom';

  @ApiProperty({ nullable: true, description: 'Labels a seeded role (a translation key).' })
  seedCode!: string | null;

  @ApiProperty({ nullable: true, description: 'The name of a custom role.' })
  name!: string | null;
}

export class MinimumOrderChangedByBody {
  @ApiProperty({ nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: MinimumOrderChangeRoleBody, nullable: true })
  role!: MinimumOrderChangeRoleBody | null;
}

export class MinimumOrderChangeBody {
  @ApiProperty({ description: 'ISO 8601 instant, UTC.' })
  changedAt!: string;

  @ApiProperty({
    type: MinimumOrderChangedByBody,
    nullable: true,
    description: 'A current member of your team; null for a former member.',
  })
  changedBy!: MinimumOrderChangedByBody | null;

  @ApiProperty({ type: MinimumOrderAmountBody, nullable: true, description: 'null: no minimum.' })
  before!: MinimumOrderAmountBody | null;

  @ApiProperty({ type: MinimumOrderAmountBody, nullable: true, description: 'null: no minimum.' })
  after!: MinimumOrderAmountBody | null;
}

export class MinimumOrderHistoryBody {
  @ApiProperty({ type: [MinimumOrderChangeBody], description: 'Newest first.' })
  items!: MinimumOrderChangeBody[];

  @ApiProperty({ nullable: true, description: 'The `after` of the next page; null at the end.' })
  next!: string | null;
}

const NO_STORE = 'no-store';

const amountOf = (value: MinimumOrderChangeView['before']): MinimumOrderAmountBody | null =>
  value === null ? null : { amount: Number(value.amount), currency: value.currency };

const changeBodyOf = (change: MinimumOrderChangeView): MinimumOrderChangeBody => ({
  changedAt: change.changedAt.toString(),
  changedBy: change.changedBy,
  before: amountOf(change.before),
  after: amountOf(change.after),
});

/** The query as the use case takes it: a digits-only `limit` becomes a number, else is refused. */
function historyInputOf(query: Record<string, unknown>): MinimumOrderHistoryInput {
  const { after, limit } = query;
  return {
    after: after ?? null,
    limit:
      limit === undefined
        ? undefined
        : typeof limit === 'string' && /^[0-9]{1,3}$/.test(limit)
          ? Number(limit)
          : 'invalid',
  };
}

const bodyOf = (view: StoreSettingsView): StoreSettingsBody => ({
  version: view.version,
  minimumOrder:
    view.minimumOrder === null
      ? null
      : { amount: Number(view.minimumOrder.amount), currency: view.minimumOrder.currency },
  currency: view.currency,
  maximumAmount: Number(view.maximumAmount),
});

/**
 * The seller's store settings over HTTP (sellers design 18; CRT-05; slice 20): read, and set or
 * clear the optional minimum order. Thin adapters: the `CallContext` comes from `@Call()` and the
 * seller session cookie; the controller authenticates only. Who may do it is the gate's rule
 * (`sellers.store-settings.edit`, approved sellers only) and the ownership the use case derives
 * from the actor: no route takes a seller id. A request body is never logged.
 */
@ApiTags('sellers')
@RoutePopulation('seller')
@ReadsSession()
@Controller('sellers/store-settings')
export class StoreSettingsController {
  readonly #logger = new Logger('StoreSettingsController');

  constructor(
    private readonly read: StoreSettingsRead,
    private readonly saveMinimumOrder: StoreSettingsSaveMinimumOrder,
    private readonly minimumOrderHistory: StoreSettingsMinimumOrderHistory,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The seller's own store settings",
    description:
      'The saved minimum order (null: no minimum), the version a save must name, the Market ' +
      'currency and the largest amount. Needs sellers.store-settings.edit and an approved seller.',
  })
  @ApiOkResponse({ type: StoreSettingsBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreSettingsBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const result = await this.read.execute(context, {});
    return bodyOf(this.settle('sellers.store-settings-read', context, response, result, 'read'));
  }

  @Get('minimum-order/history')
  @ApiOperation({
    summary: 'The changes of the minimum order',
    description:
      'Newest first: when, who (a current member of your team, or null for a former member), ' +
      'and the value before and after (null: no minimum). Read from the audit log. Paged with ' +
      `after (the next of the previous page) and limit (1 to ${MAX_MINIMUM_ORDER_HISTORY_PAGE}, ` +
      `default ${MINIMUM_ORDER_HISTORY_PAGE}). Needs sellers.store-settings.edit and an ` +
      'approved seller.',
  })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: MinimumOrderHistoryBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async getMinimumOrderHistory(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MinimumOrderHistoryBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const result = await this.minimumOrderHistory.execute(context, historyInputOf(query));
    const page = this.settle(
      'sellers.store-settings-minimum-order-history',
      context,
      response,
      result,
      'read',
    );
    return { items: page.items.map(changeBodyOf), next: page.next };
  }

  @Put('minimum-order')
  @RequiresStepUp('sellers.store-terms.change')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set or clear the minimum order',
    description:
      'The least a customer must spend with this seller to check out (shipping not counted; ' +
      'entered in the Market price convention). minimumOrder null clears it. The amount is a ' +
      'whole number of minor units above zero and at most the Market maximum; the currency is the ' +
      "Market's. A stale expectedVersion is conflict.stale. Applies to open carts on their next " +
      'read. Audited; no event.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SaveMinimumOrderRequest })
  @ApiOkResponse({ type: StoreSettingsBody })
  @ApiBadRequestResponse({
    type: SellersErrorBody,
    description: 'validation.failed, minimum-order.amount or minimum-order.currency',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'request.csrf or access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiConflictResponse({ type: SellersErrorBody, description: 'conflict.stale (read and retry)' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: SellersErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'sellers.unavailable or access.unavailable',
  })
  async putMinimumOrder(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<StoreSettingsBody> {
    response.setHeader('Cache-Control', NO_STORE);
    const msg = 'sellers.store-settings-save-minimum-order';
    if (request.is('application/json') !== 'application/json') {
      this.log(msg, context, 'request.body-unsupported');
      throw fail(415, 'request.body-unsupported');
    }
    const parsed = parseMinimumOrderBody(body);
    if (Array.isArray(parsed)) {
      this.log(msg, context, 'validation.failed');
      throw fail(400, 'validation.failed', { fields: parsed });
    }
    const result = await this.saveMinimumOrder.execute(context, parsed as MinimumOrderBody);
    return bodyOf(this.settle(msg, context, response, result, 'saved'));
  }

  private settle<T>(
    msg: string,
    context: CallContext,
    response: Response,
    result: Result<T, MyFileError>,
    okCode: string,
  ): T {
    this.log(msg, context, result.ok ? okCode : result.error.code);
    if (!result.ok) throw errorOf(result.error, response);
    return result.value;
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
