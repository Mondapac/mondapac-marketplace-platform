import { Controller, Get, Header, Logger, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminOutOfStockVariants } from '../application/use-cases/admin-out-of-stock-variants.use-case';
import { fail } from './http-answers';

/**
 * The platform-wide stock reads of the admin panel. A thin adapter: each use case decides through
 * its gate; the answer is `{ statusCode, code, details? }` on a refusal.
 */
@ApiTags('inventory')
@RoutePopulation('admin')
@ReadsSession()
@Controller('inventory/admin')
export class AdminInventoryController {
  readonly #logger = new Logger('AdminInventoryController');

  constructor(private readonly outOfStockVariants: AdminOutOfStockVariants) {}

  @Get('variants/out-of-stock-everywhere')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List the Variants that are out of stock everywhere',
    description:
      'Needs catalog.variant.view. Variants with at least one live sell unit whose sell units ' +
      'are all out, ascending by id, with the total of the Market.',
  })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 500; default 100.' })
  async outOfStockEverywhere(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.outOfStockVariants.execute(context, {
      cursor,
      limit: typeof limit === 'string' && /^[0-9]{1,4}$/.test(limit) ? Number(limit) : limit,
    });
    if (result.ok) {
      this.#logger.log({
        msg: 'inventory.admin-out-of-stock-variants',
        outcome: 'ok',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return {
        variantIds: result.value.variantIds,
        nextCursor: result.value.nextCursor,
        total: result.value.total,
      };
    }
    const error = result.error as { code: string; fields?: unknown };
    const status =
      error.code === 'validation.failed'
        ? 400
        : ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
    if (status === undefined) {
      this.#logger.error({ msg: 'inventory.unmapped-refusal', code: error.code });
      throw fail(500, 'internal');
    }
    throw error.fields !== undefined
      ? fail(status, error.code, { fields: error.fields })
      : fail(status, error.code);
  }
}
