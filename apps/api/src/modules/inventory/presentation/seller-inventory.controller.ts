import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CreateSource } from '../application/use-cases/create-source.use-case';
import { EditSource } from '../application/use-cases/edit-source.use-case';
import { ListSources } from '../application/use-cases/list-sources.use-case';
import { ReorderSources } from '../application/use-cases/reorder-sources.use-case';
import { SetStockLevel } from '../application/use-cases/set-stock-level.use-case';
import { closedBody, fail } from './http-answers';

/** The HTTP status of each refusal of the seller inventory routes. */
export const SELLER_INVENTORY_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'inventory.not-found': 404,
  'inventory.source.not-found': 404,
  'inventory.not-ready': 409,
  'conflict.stale': 409,
  'inventory.sources.limit-reached': 422,
  'inventory.sources.order-mismatch': 422,
  'inventory.stock.below-held': 422,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

type SourcesView = Extract<
  Awaited<ReturnType<ListSources['execute']>>,
  { readonly ok: true }
>['value'];

type Failure = {
  readonly code: string;
  readonly fields?: unknown;
  readonly details?: unknown;
};

function sourcesBody(view: SourcesView) {
  return {
    version: view.version,
    max: view.max,
    sources: view.sources.map((source) => ({
      id: source.id,
      name: source.name,
      isDefault: source.isDefault,
      position: source.position,
      address: source.address,
      timeZone: source.timeZone,
      createdAt: source.createdAt.toString(),
    })),
  };
}

/**
 * The seller's stock locations and stock levels over HTTP (inventory design 6; UX F29). A thin
 * adapter: the seller comes from the session (`@ReadsSession`), each use case decides through
 * its gate, and the answer is `{ statusCode, code, details? }` on a refusal. Locations hold
 * personal data, so every answer is `no-store` and no log line carries a body.
 */
@ApiTags('inventory')
@RoutePopulation('seller')
@ReadsSession()
@Controller('inventory/seller')
export class SellerInventoryController {
  readonly #logger = new Logger('SellerInventoryController');

  constructor(
    private readonly listSources: ListSources,
    private readonly createSource: CreateSource,
    private readonly editSource: EditSource,
    private readonly reorderSources: ReorderSources,
    private readonly setStockLevel: SetStockLevel,
  ) {}

  @Get('sources')
  @ApiOperation({ summary: 'List the seller’s stock locations in priority order' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.answer(
      'list-sources',
      context,
      response,
      await this.listSources.execute(context, {}),
      sourcesBody,
    );
  }

  @Post('sources')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a stock location (last in the order)' })
  @ApiHeader(CSRF)
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = closedBody(request, body, ['expectedVersion', 'name', 'address', 'timeZone']);
    if (input instanceof HttpException)
      return this.refused('create-source', context, response, input);
    return this.answer(
      'create-source',
      context,
      response,
      await this.createSource.execute(context, {
        expectedVersion: input.expectedVersion as number,
        name: input.name as string,
        address: input.address as Record<string, string> | null,
        timeZone: input.timeZone as string | null,
      }),
      sourcesBody,
    );
  }

  @Put('sources/:sourceId')
  @ApiOperation({ summary: 'Change a stock location (the whole form)' })
  @ApiHeader(CSRF)
  async edit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = closedBody(request, body, ['expectedVersion', 'name', 'address', 'timeZone']);
    if (input instanceof HttpException)
      return this.refused('edit-source', context, response, input);
    return this.answer(
      'edit-source',
      context,
      response,
      await this.editSource.execute(context, {
        sourceId,
        expectedVersion: input.expectedVersion as number,
        name: input.name as string,
        address: input.address as Record<string, string> | null,
        timeZone: input.timeZone as string | null,
      }),
      sourcesBody,
    );
  }

  @Put('sources-order')
  @ApiOperation({ summary: 'Set the priority order of the stock locations' })
  @ApiHeader(CSRF)
  async reorder(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = closedBody(request, body, ['expectedVersion', 'orderedSourceIds']);
    if (input instanceof HttpException)
      return this.refused('reorder-sources', context, response, input);
    return this.answer(
      'reorder-sources',
      context,
      response,
      await this.reorderSources.execute(context, {
        expectedVersion: input.expectedVersion as number,
        orderedSourceIds: input.orderedSourceIds as string[],
      }),
      sourcesBody,
    );
  }

  @Put('offers/:offerId/variants/:variantId/sources/:sourceId/stock')
  @ApiOperation({ summary: 'Set the stock level of one Variant at one location' })
  @ApiHeader(CSRF)
  async setStock(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('offerId') offerId: string,
    @Param('variantId') variantId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = closedBody(request, body, ['onHand', 'expectedVersion']);
    if (input instanceof HttpException)
      return this.refused('set-stock-level', context, response, input);
    return this.answer(
      'set-stock-level',
      context,
      response,
      await this.setStockLevel.execute(context, {
        offerId,
        variantId,
        sourceId,
        onHand: input.onHand as number,
        expectedVersion: input.expectedVersion as number | null,
      }),
      (value) => ({
        stockItemId: value.stockItemId,
        onHand: value.onHand,
        version: value.version,
        changed: value.changed,
      }),
    );
  }

  private answer<V, F extends Failure>(
    name: string,
    context: CallContext,
    response: Response,
    result: Result<V, F | { readonly code: string }>,
    map: (value: V) => unknown,
  ): unknown {
    response.setHeader('Cache-Control', 'no-store');
    if (result.ok) {
      this.log(name, context, 'ok');
      return map(result.value);
    }
    const error = result.error as Failure;
    const status =
      SELLER_INVENTORY_STATUS[error.code] ??
      ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (status === undefined) {
      this.#logger.error({ msg: 'inventory.unmapped-refusal', code: error.code });
      throw fail(500, 'internal');
    }
    this.log(name, context, error.code, status >= 500);
    const details =
      error.fields !== undefined ? { fields: error.fields } : (error.details as object | undefined);
    throw details === undefined ? fail(status, error.code) : fail(status, error.code, details);
  }

  private refused(
    name: string,
    context: CallContext,
    response: Response,
    error: HttpException,
  ): never {
    response.setHeader('Cache-Control', 'no-store');
    this.log(name, context, (error.getResponse() as { code: string }).code);
    throw error;
  }

  private log(name: string, context: CallContext, outcome: string, warn = false): void {
    this.#logger[warn ? 'warn' : 'log']({
      msg: `inventory.${name}`,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
