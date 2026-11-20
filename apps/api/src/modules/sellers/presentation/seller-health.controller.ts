import { Controller, Get, HttpCode, Logger, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RequestSellerHealthRecalculation } from '../application/use-cases/request-seller-health-recalculation.use-case';
import { SellerHealthQueueRead } from '../application/use-cases/seller-health-queue.use-case';
import { SellerHealthQueueExport } from '../application/use-cases/seller-health-queue-export.use-case';
import { SellerHealthQueueQuery } from '../application/use-cases/seller-health-queue-query.use-case';
import {
  HEALTH_QUEUE_EXPORT_COLUMNS,
  HEALTH_QUEUE_SORT_KEYS,
  HEALTH_QUEUE_VIEWS,
} from '../domain/health-queue-list';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { SellerHealthRead } from '../application/use-cases/seller-health-read.use-case';
import { errorOf, fail } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import {
  SellerHealthBody,
  SellerHealthQueueBody,
  SellerHealthQueueListBody,
  SellerHealthRecalculationBody,
} from './seller-health.dto';

/**
 * The admin's seller health card over HTTP (seller health package 5). A thin adapter: the
 * `CallContext` comes from `@Call()` and the admin session cookie (`@RoutePopulation('admin')`
 * with `@ReadsSession()`); the controller authenticates only. Who may read is the gate of the use
 * case (`sellers.seller.view`) and the Market is the request's. The response is
 * `Cache-Control: no-store`, errors included. Health only informs; nothing here acts on a seller.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@Controller('sellers/admin')
export class SellerHealthController {
  readonly #logger = new Logger('SellerHealthController');

  constructor(
    private readonly read: SellerHealthRead,
    private readonly queue: SellerHealthQueueRead,
    private readonly queueList: SellerHealthQueueQuery,
    private readonly queueExport: SellerHealthQueueExport,
    private readonly recalculate: RequestSellerHealthRecalculation,
  ) {}

  @Get('health-queue')
  @ReadsSession()
  @ApiOperation({
    summary: 'Sellers that need a look (admin)',
    description:
      'The sellers whose latest stored health is unhealthy, worst score first, with the metric ' +
      'that set it. Health only informs: nothing happens to the seller. Needs sellers.seller.view.',
  })
  @ApiOkResponse({ type: SellerHealthQueueBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async healthQueue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthQueueBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.queue.execute(context, {});
    this.#logger.log({
      msg: 'sellers.seller-health-queue-route',
      outcome: result.ok ? 'read' : result.error.code,
      ...(result.ok ? { rows: result.value.items.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      items: result.value.items.map((item) => ({ ...item })),
      truncated: result.value.truncated,
    };
  }

  @Get('health-queue/list')
  @ReadsSession()
  @ApiOperation({
    summary: 'Sellers that need a look as a super list (admin)',
    description:
      'Needs sellers.seller.view. Views (all, or the metric that set the score) with counts, ' +
      'filters (`metric`, `q` = a store name or slug prefix of 2 to 100 characters, `sellerId`, ' +
      '`minScore`/`maxScore`), sort (score, name or day, with direction; worst score first by ' +
      'default), page numbers with a total (`paging=pages`, default) or Previous/Next without ' +
      'one (`paging=prev-next`) and each row\u2019s actions. The queue holds at most 200 ' +
      'sellers (`truncated`). Health only informs: nothing happens to the seller.',
  })
  @ApiQuery({ name: 'view', required: false, enum: HEALTH_QUEUE_VIEWS })
  @ApiQuery({ name: 'metric', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'minScore', required: false, description: '0 to 100.' })
  @ApiQuery({ name: 'maxScore', required: false, description: '0 to 100.' })
  @ApiQuery({ name: 'sort', required: false, enum: HEALTH_QUEUE_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ApiQuery({ name: 'page', required: false, description: 'From 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: SellerHealthQueueListBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async healthQueueList(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthQueueListBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.queueList.execute(context, numbersOf(query));
    this.#logger.log({
      msg: 'sellers.seller-health-queue-list-route',
      outcome: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error as Parameters<typeof errorOf>[0], response);
    return {
      ...result.value,
      items: result.value.items.map((row) => ({ ...row, actions: [...row.actions] })),
    };
  }

  @Get('health-queue/export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the sellers that need a look as a file (admin)',
    description:
      'Needs sellers.seller.view. `format` is csv (default) or xlsx. `columns` is the ' +
      `comma-separated optional columns in the order shown (${HEALTH_QUEUE_EXPORT_COLUMNS.join(', ')}); ` +
      'store, slug, score and lowest metric are always there. The rows are `ids` (seller ids, ' +
      'comma-separated, at most 200; an id that is not in the queue refuses the whole file as ' +
      'not found; no filter or sort beside them) or the selector keys of the list (refused with ' +
      'batch.too-large when the queue was cut at 200, because sellers would be missing). CSV: a ' +
      'text cell that starts with = + - @ gets a leading quote. XLSX: every cell is a string.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiOkResponse({
    description:
      'sellers-needing-attention-<date>.csv or sellers-needing-attention-<date>.xlsx, as an attachment',
  })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'file.not-found' })
  @ApiPayloadTooLargeResponse({ type: SellersErrorBody, description: 'batch.too-large (max)' })
  async healthQueueDownload(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.queueExport.execute(context, { ...query });
    this.#logger.log({
      msg: 'sellers.seller-health-queue-export-route',
      outcome: result.ok ? 'export' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error =
        result.error.code === 'batch.too-large'
          ? fail(413, 'batch.too-large', { max: result.error.max })
          : errorOf(result.error, response);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'sellers.seller-health-queue-export-route',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Get(':sellerId/health')
  @ReadsSession()
  @ApiOperation({
    summary: "A seller's health card (admin)",
    description:
      'The latest stored score of the seller with its five metrics, and the 90-day trend. ' +
      'Read from what the nightly run stored; nothing is computed here. Needs sellers.seller.view.',
  })
  @ApiOkResponse({ type: SellerHealthBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (no such seller in this Market)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async sellerHealth(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.read.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-health-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return {
      sellerId: result.value.sellerId,
      current:
        result.value.current === null
          ? null
          : {
              ...result.value.current,
              metrics: result.value.current.metrics.map((m) => ({ ...m })),
            },
      trend: result.value.trend.map((point) => ({ ...point })),
    };
  }

  @Post(':sellerId/health/recalculate')
  @HttpCode(202)
  @ReadsSession()
  @ApiOperation({
    summary: "Recalculate a seller's health now (admin)",
    description:
      'Queues a recount of one seller. The job measures it within about two minutes and the ' +
      'card then shows the new score; nothing is computed in this request. A second request ' +
      'while one waits adds nothing. Health only informs: nothing happens to the seller. ' +
      'Needs sellers.seller-health.recalculate.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiAcceptedResponse({ type: SellerHealthRecalculationBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (no such seller, or not approved yet, in this Market)',
  })
  @ApiServiceUnavailableResponse({ type: SellersErrorBody, description: 'sellers.unavailable' })
  async recalculateHealth(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerHealthRecalculationBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.recalculate.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.seller-health-recalculate-route',
      outcome: result.ok ? result.value.status : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    return { status: result.value.status };
  }
}

/** `page` and `pageSize` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined) {
      out[key] = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : -1;
    }
  }
  return out;
}
