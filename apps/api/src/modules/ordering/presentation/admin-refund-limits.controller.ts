import { Body, Controller, Delete, Get, Logger, Param, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminRemoveRefundLimit } from '../application/use-cases/admin-remove-refund-limit.use-case';
import { AdminSetRefundLimit } from '../application/use-cases/admin-set-refund-limit.use-case';
import { AdminViewRefundLimits } from '../application/use-cases/admin-view-refund-limits.use-case';
import { closedBody, refusal } from './http-answers';
import {
  REFUND_LIMIT_BODY_KEYS,
  RefundLimitRequestBody,
  RefundLimitsBody,
  refundLimitsBody,
} from './refund-limits.dto';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const SET_DESCRIPTION =
  'Needs ordering.refund-limits.manage (protected). A seller refund (units marked unavailable) ' +
  'is refused when it would pass the cap in force in any 24 hours: the number of refunds or ' +
  'their amount. Audited. expectedVersion is the version read (0 for a cap not set yet); ' +
  '409 conflict.retry when another admin changed it first.';

/** A version from a query string: digits only, else -1 (the use case refuses it). */
const parseVersionQuery = (value: unknown): number =>
  typeof value === 'string' && /^[0-9]{1,7}$/.test(value) ? Number(value) : -1;

/**
 * The caps on refunds sellers start by marking units unavailable (order detail decision 6;
 * Hassan F2; owner decision 2026-11-11): the Market's default and any seller's own. The
 * controller authenticates only; the use cases need `ordering.refund-limits.view` or
 * `ordering.refund-limits.manage`. Every response is `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/refund-limits')
export class AdminRefundLimitsController {
  readonly #logger = new Logger('AdminRefundLimitsController');

  constructor(
    private readonly view: AdminViewRefundLimits,
    private readonly set: AdminSetRefundLimit,
    private readonly remove: AdminRemoveRefundLimit,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The caps on seller refunds: the Market default, and one seller’s own (admin)',
    description: 'Needs ordering.refund-limits.view.',
  })
  @ApiQuery({ name: 'sellerId', required: false, description: 'A seller id: its own cap too.' })
  @ApiOkResponse({ type: RefundLimitsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async limits(
    @Call() context: CallContext,
    @Query('sellerId') sellerId: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    this.log(
      'ordering.admin-view-refund-limits-route',
      context,
      result.ok ? 'ok' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return refundLimitsBody(result.value);
  }

  @Put()
  @ApiOperation({
    summary: "Set the Market's default cap on seller refunds (admin)",
    description: SET_DESCRIPTION,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RefundLimitRequestBody })
  @ApiOkResponse({ type: RefundLimitsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.retry' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async setDefault(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    return this.setLimit(context, null, request, response, body);
  }

  @Put('sellers/:sellerId')
  @ApiOperation({
    summary: "Set one seller's own cap on its refunds (admin)",
    description: SET_DESCRIPTION,
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: RefundLimitRequestBody })
  @ApiOkResponse({ type: RefundLimitsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.retry' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async setSeller(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    return this.setLimit(context, sellerId, request, response, body);
  }

  @Delete('sellers/:sellerId')
  @ApiOperation({
    summary: "Remove one seller's own cap: the Market default applies again (admin)",
    description: 'Needs ordering.refund-limits.manage (protected). Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiQuery({ name: 'expectedVersion', required: true, description: 'The version read.' })
  @ApiOkResponse({ type: RefundLimitsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ordering.refund-limit-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.retry' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async removeSeller(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Query('expectedVersion') expectedVersion: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, {
      sellerId,
      expectedVersion: parseVersionQuery(expectedVersion),
    });
    this.log(
      'ordering.admin-remove-refund-limit-route',
      context,
      result.ok ? 'removed' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return refundLimitsBody(result.value);
  }

  private async setLimit(
    context: CallContext,
    sellerId: string | null,
    request: Request,
    response: Response,
    body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, REFUND_LIMIT_BODY_KEYS);
    if (invalid !== null) throw invalid;
    const { maxCount, maxAmount, expectedVersion } = body as Record<string, unknown>;
    const result = await this.set.execute(context, {
      sellerId,
      maxCount,
      maxAmount,
      expectedVersion,
    });
    this.log(
      'ordering.admin-set-refund-limit-route',
      context,
      result.ok ? 'saved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return refundLimitsBody(result.value);
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
