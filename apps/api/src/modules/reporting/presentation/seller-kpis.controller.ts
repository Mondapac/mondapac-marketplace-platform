import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ExportSellerDaily } from '../application/use-cases/export-seller-daily.use-case';
import { ViewSellerKpis } from '../application/use-cases/view-seller-kpis.use-case';
import { ViewSellerNetEarnings } from '../application/use-cases/view-seller-net-earnings.use-case';
import { SetSellerMonthlyGoal } from '../application/use-cases/set-seller-monthly-goal.use-case';
import { ViewSellerMonthlyGoal } from '../application/use-cases/view-seller-monthly-goal.use-case';
import { DAILY_EXPORT_QUERY, sendDailyExport } from './daily-export-response';
import {
  SellerGoalBody,
  sellerGoalBody,
  SellerKpisBody,
  SellerNetEarningsBody,
  SetSellerGoalRequest,
  sellerKpisBody,
  sellerNetEarningsBody,
  type SellerGoalSection,
} from './seller-kpis.dto';

const ERROR = { type: Object };

/** How long the goal section may take before it answers `error` (as the admin KPI sections). */
export const SELLER_GOAL_TIMEOUT_MS = 1_500;

/** The fields the goal body may carry; any other is `validation.failed` (a closed body). */
const GOAL_FIELDS = ['month', 'amount', 'currency', 'expectedVersion'];

/** The 400 body: `details.fields` when the refusal names them. */
export function validationBody(error: {
  readonly fields?: readonly { readonly path: string; readonly code: string }[];
}): Record<string, unknown> {
  return error.fields === undefined || error.fields.length === 0
    ? { statusCode: 400, code: 'validation.failed' }
    : { statusCode: 400, code: 'validation.failed', details: { fields: error.fields } };
}

/**
 * The seller's KPI read (dashboards upgrade, option B, phase 6). `Cache-Control: no-store`. Logs
 * ids and codes only, never an amount.
 */
@ApiTags('reporting')
@RoutePopulation('seller')
@ReadsSession()
@Controller('reporting/seller')
export class SellerKpisController {
  readonly #logger = new Logger('SellerKpisController');

  constructor(
    private readonly kpis: ViewSellerKpis,
    private readonly netEarnings: ViewSellerNetEarnings,
    private readonly exportDaily: ExportSellerDaily,
    private readonly viewGoal: ViewSellerMonthlyGoal,
    private readonly setGoal: SetSellerMonthlyGoal,
  ) {}

  /**
   * The goal section of the KPI body: null when the use case refuses (the viewer may not read it),
   * `error` when it fails, throws or takes longer than {@link SELLER_GOAL_TIMEOUT_MS}, so the KPI
   * strip never waits on it or fails with it.
   */
  private async goalSection(context: CallContext): Promise<SellerGoalSection> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), SELLER_GOAL_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const answer = await Promise.race([this.viewGoal.execute(context, {}), limit]);
      if (answer === 'timed-out') {
        this.#logger.warn({
          msg: 'reporting.seller-goal.section',
          outcome: 'timeout',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
        return { status: 'error' };
      }
      if (answer.ok) return { status: 'ok', value: answer.value };
      if (
        answer.error.code === 'access.denied' ||
        answer.error.code === 'access.seller-not-approved'
      ) {
        return null;
      }
      return { status: 'error' };
    } catch (error) {
      this.#logger.warn({
        msg: 'reporting.seller-goal.section',
        outcome: 'threw',
        error: error instanceof Error ? error.constructor.name : typeof error,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return { status: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  @Get('kpis')
  @ApiOperation({
    summary: "The seller's own KPIs and trend for a period, against the period before",
    description:
      "Always the session's own seller (never an id from input); needs `ordering.seller-order.view`. " +
      'Days are the Market\'s days, not UTC. Figures come from the daily rollups, so "today" is as ' +
      'fresh as the last event (see `refreshedAt`). Money is a decimal string of minor units. ' +
      'Shipped on time counts shipped orders only (an unshipped overdue order is a task, not yet ' +
      'a KPI; FE-127). A custom range (`from` and `to`, Market days, both included) is at most 13 ' +
      "calendar months and ends by the Market's today; it is compared with as many days before it.",
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month', 'custom'] })
  @ApiQuery({ name: 'from', required: false, description: 'First Market day (YYYY-MM-DD).' })
  @ApiQuery({ name: 'to', required: false, description: 'Last Market day (YYYY-MM-DD).' })
  @ApiOkResponse({ type: SellerKpisBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: period, from, to)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Query('period') period: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerKpisBody> {
    response.setHeader('Cache-Control', 'no-store');
    const [result, goal] = await Promise.all([
      this.kpis.execute(context, { period, from, to }),
      this.goalSection(context),
    ]);
    const actor = context.actor;
    this.#logger.log({
      msg: 'reporting.seller-kpis',
      outcome: result.ok ? 'ok' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException(validationBody(result.error), 400);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerKpisBody(result.value, goal);
  }

  @Put('monthly-goal')
  @HttpCode(200)
  @ApiOperation({
    summary: "Set the seller's own sales goal for a month",
    description:
      "Always the session's own seller (never an id from input); needs " +
      '`reporting.seller-goal.manage`, denied while the seller is not approved. `month` is this ' +
      "calendar month of the Market's zone or one of the next 12; `amount` is sales with GST in " +
      "minor units above zero (at most 15 digits), in the Market's currency. The body carries the " +
      'version seen (`sellerGoal.goal.version` of the KPI read; 0 for none): a stale edit is 409 ' +
      '`reporting.seller-goal-conflict`. Audited; the goal in force changes nothing. A goal is ' +
      'changed, not removed.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SetSellerGoalRequest })
  @ApiOkResponse({ type: SellerGoalBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: month, amount, currency, expectedVersion)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiConflictResponse({ ...ERROR, description: 'reporting.seller-goal-conflict' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async putGoal(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerGoalBody> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.is('application/json') !== 'application/json') {
      throw new HttpException({ statusCode: 415, code: 'request.body-unsupported' }, 415);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpException(validationBody({ fields: [{ path: '', code: 'type' }] }), 400);
    }
    const unknown = Object.keys(body).filter((key) => !GOAL_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new HttpException(
        validationBody({ fields: [{ path: '', code: 'unknown-field' }] }),
        400,
      );
    }
    const { month, amount, currency, expectedVersion } = body as Record<string, unknown>;
    const result = await this.setGoal.execute(context, {
      month,
      amount,
      currency,
      expectedVersion,
    });
    const actor = context.actor;
    this.#logger.log({
      msg: 'reporting.seller-goal.set',
      outcome: result.ok ? 'set' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException(validationBody(result.error), 400);
      }
      if (result.error.code === 'reporting.seller-goal-conflict') {
        throw new HttpException({ statusCode: 409, code: result.error.code }, 409);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerGoalBody(result.value);
  }

  @Get('net-earnings')
  @ApiOperation({
    summary: "The seller's own net earnings for a dashboard period",
    description:
      "Always the session's own seller (never an id from input); needs " +
      '`commission-payouts.earnings.view` (the key of the seller ledger). The period is the same ' +
      "as the KPI strip's, counted in the Market's days. Without GST. `ready` is false, and " +
      '`netEarnings` null, until a week of matching ledger exists (FE-066): a partial figure is ' +
      'never sent. Money is a decimal string of minor units. A custom range (`from` and `to`, ' +
      "Market days, both included) follows the KPI strip's rules: at most 13 calendar months, " +
      "ending by the Market's today.",
  })
  @ApiQuery({ name: 'period', required: false, enum: ['today', '7d', '30d', 'month', 'custom'] })
  @ApiQuery({ name: 'from', required: false, description: 'First Market day (YYYY-MM-DD).' })
  @ApiQuery({ name: 'to', required: false, description: 'Last Market day (YYYY-MM-DD).' })
  @ApiOkResponse({ type: SellerNetEarningsBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: period, from, to)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async getNetEarnings(
    @Call() context: CallContext,
    @Query('period') period: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerNetEarningsBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.netEarnings.execute(context, { period, from, to });
    const actor = context.actor;
    this.#logger.log({
      msg: 'reporting.seller-net-earnings',
      outcome: result.ok ? 'ok' : result.error.code,
      sellerId: actor.kind === 'authenticated' ? actor.sellerId : null,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      if (result.error.code === 'validation.failed') {
        throw new HttpException(validationBody(result.error), 400);
      }
      const status = ACCESS_DENIED_STATUS[result.error.code];
      throw new HttpException({ statusCode: status, code: result.error.code }, status);
    }
    return sellerNetEarningsBody(result.value);
  }

  @Get('daily/export')
  @ApiOperation({
    summary: "The seller's own figures per Market day of a period, as a CSV or XLSX file",
    description:
      "Always the session's own seller (a sellerId in the query is validation.failed); needs " +
      'ordering.seller-order.view and reporting.seller-report.export, denied while the seller is ' +
      "not approved. One row per Market day (never UTC): a preset (default 30d) or a custom range of at most 13 calendar months that ends by the Market's today. Money is minor units with " +
      'the currency in its own column. Every download is audited on the seller (range, format, ' +
      'row count). The file streams as an attachment (sales-daily-<from>-<to>.csv).',
  })
  @ApiQuery(DAILY_EXPORT_QUERY.period)
  @ApiQuery(DAILY_EXPORT_QUERY.from)
  @ApiQuery(DAILY_EXPORT_QUERY.to)
  @ApiQuery(DAILY_EXPORT_QUERY.format)
  @ApiOkResponse({ description: 'text/csv; charset=utf-8, or an XLSX file, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or access.seller-not-approved' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportDaily.execute(context, { ...query });
    await sendDailyExport(result, context, response, this.#logger, 'reporting.seller-daily-export');
  }
}
