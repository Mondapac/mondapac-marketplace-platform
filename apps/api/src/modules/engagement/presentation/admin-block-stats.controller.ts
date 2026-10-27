import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ViewBlockStats } from '../application/use-cases/view-block-stats.use-case';
import { MAX_STATS_DAYS } from '../domain/block-count';
import { PageBlockStatsBody, pageBlockStatsBody } from './engagement.dto';
import { logRoute, refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * How often each block of a storefront page was shown and clicked, for admins (personalization
 * 1d-3, part C). Needs storefront's `storefront.page.stats`. Aggregate daily numbers only: no
 * person, cookie or address is kept, so none can be shown. The answer is `no-store`.
 */
@ApiTags('engagement')
@RoutePopulation('admin')
@ReadsSession()
@Controller('engagement/admin/block-stats')
export class AdminBlockStatsController {
  readonly #logger = new Logger('AdminBlockStatsController');

  constructor(private readonly stats: ViewBlockStats) {}

  @Get()
  @ApiOperation({
    summary: "A page's block impressions and clicks per day (admin)",
    description:
      `Needs storefront.page.stats. page, from and to are required; at most ${MAX_STATS_DAYS} ` +
      'days, both included (UTC). A page with no counts, or of another Market, answers no blocks. ' +
      'The numbers are unverified (anyone can send valid ids; clicks may exceed impressions): ' +
      'never use them for automatic ranking, selection or payouts.',
  })
  @ApiQuery({ name: 'page', required: true, description: 'A storefront page id (uuid).' })
  @ApiQuery({ name: 'from', required: true, description: 'First UTC day, YYYY-MM-DD.' })
  @ApiQuery({ name: 'to', required: true, description: 'Last UTC day, YYYY-MM-DD.' })
  @ApiOkResponse({ type: PageBlockStatsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async view(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<PageBlockStatsBody> {
    // Set first, so an error answer is `no-store` too.
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.stats.execute(context, { query });
    logRoute(
      this.#logger,
      'engagement.view-block-stats-route',
      context,
      result.ok ? 'ok' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return pageBlockStatsBody(result.value);
  }
}
