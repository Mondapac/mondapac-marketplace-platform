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
import {
  ViewAssistantInsights,
  type AssistantInsights,
} from '../application/use-cases/view-assistant-insights.use-case';
import { InsightsBody } from './assistant.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

/** The JSON of an insights read: days and instants as ISO strings. */
function insightsBody(insights: AssistantInsights) {
  return {
    from: insights.from.toString(),
    to: insights.to.toString(),
    days: insights.days.map((day) => ({ ...day, day: day.day.toString() })),
    totals: insights.totals,
    feedback: insights.feedback,
    handoffs: insights.handoffs,
    unanswered: {
      ...insights.unanswered,
      rows: insights.unanswered.rows.map((row) => ({ ...row, lastAt: row.lastAt.toString() })),
    },
  };
}

/**
 * How the buyer assistant is doing, for an admin (B3). A thin adapter: the use case does the
 * work behind its gate. `Cache-Control: no-store`; the buyer text it returns is the masked text
 * that was stored, and is never logged.
 */
@ApiTags('assistant')
@RoutePopulation('admin')
@ReadsSession()
@Controller('assistant/admin/insights')
export class AdminAssistantInsightsController {
  readonly #logger = new Logger('AdminAssistantInsightsController');

  constructor(private readonly view: ViewAssistantInsights) {}

  @Get()
  @ApiOperation({
    summary: 'Buyer assistant insights (admin)',
    description:
      'Needs assistant.settings.view. from and to are days of the Market calendar (YYYY-MM-DD, ' +
      'both included; default the last 30 days; at most 92). Returns conversations and spend per ' +
      'day, the thumbs up/down share, support hand-offs and the unanswered questions: turns with ' +
      'the unavailable or tool-failed notice, an empty product search or a thumbs down, grouped ' +
      'by normalized query (top 200, paged with page and pageSize). Only the retained, masked ' +
      'buyer text is shown.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiOkResponse({ type: InsightsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async insights(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, query);
    this.#logger.log({
      msg: 'assistant.view-assistant-insights-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return insightsBody(result.value);
  }
}
