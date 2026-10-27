import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { ClearSellerPayoutTerms } from '../application/use-cases/clear-seller-payout-terms.use-case';
import { ListSellerPayoutHolds } from '../application/use-cases/list-seller-payout-holds.use-case';
import { PlacePayoutHold } from '../application/use-cases/place-payout-hold.use-case';
import { ReleasePayoutHold } from '../application/use-cases/release-payout-hold.use-case';
import { SetSellerPayoutTerms } from '../application/use-cases/set-seller-payout-terms.use-case';
import { ViewSellerPayoutTerms } from '../application/use-cases/view-seller-payout-terms.use-case';
import {
  payoutHoldBody,
  PayoutHoldBody,
  PayoutHoldsBody,
  payoutTermsBody,
  PayoutTermsBody,
  PlacePayoutHoldRequest,
  ReleasePayoutHoldRequest,
  SetPayoutTermsRequest,
} from './commission-payouts.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const TERMS_KEYS = [
  'weekdays',
  'localTime',
  'holdDaysCarrier',
  'holdDaysSellerClick',
  'minimumMinor',
  'approvalMode',
  'expectedVersion',
];

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * A seller's payout terms (package 6b; G2 4.4), for admins: the Market's terms with the seller's
 * own over them. Thin adapters: each use case does its work behind its gate. Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('admin')
@ReadsSession()
@Controller('commission-payouts/admin/sellers/:sellerId/payout-terms')
export class AdminPayoutTermsController {
  readonly #logger = new Logger('AdminPayoutTermsController');

  constructor(
    private readonly view: ViewSellerPayoutTerms,
    private readonly set: SetSellerPayoutTerms,
    private readonly clear: ClearSellerPayoutTerms,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A seller's payout terms (admin)",
    description:
      "Needs commission-payouts.payout-terms.view. The terms in force (the seller's own values over the Market's), the seller's own values and the version to send back on a change.",
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: PayoutTermsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.seller-not-found' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.terms-unavailable or commission-payouts.unavailable',
  })
  async get(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { sellerId });
    logRoute(
      this.#logger,
      'commission-payouts.view-seller-payout-terms-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutTermsBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: "Set a seller's own payout terms (admin)",
    description:
      "Needs commission-payouts.payout-terms.edit (protected: a recent second-factor confirmation, refused in a Login-as-Seller session). Replaces the seller's override: a field left out uses the Market's value. Hold days are 7 to 60. Audited with before and after.",
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: SetPayoutTermsRequest })
  @ApiOkResponse({ type: PayoutTermsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.seller-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'commission-payouts.version-conflict' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.terms-unavailable or commission-payouts.unavailable',
  })
  async put(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, TERMS_KEYS);
    if (invalid !== null) throw invalid;
    const { expectedVersion, ...terms } = requestBody as Record<string, unknown>;
    const result = await this.set.execute(context, { sellerId, terms, expectedVersion });
    logRoute(
      this.#logger,
      'commission-payouts.set-seller-payout-terms-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutTermsBody(result.value);
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({
    summary: "Remove a seller's own payout terms (admin)",
    description:
      "Needs commission-payouts.payout-terms.edit (protected). The seller is back on the Market's terms. Audited with before and after.",
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiQuery({
    name: 'expectedVersion',
    required: true,
    description: 'The override version the admin saw.',
  })
  @ApiOkResponse({ type: PayoutTermsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'commission-payouts.seller-not-found or commission-payouts.terms-not-set',
  })
  @ApiConflictResponse({ ...ERROR, description: 'commission-payouts.version-conflict' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'commission-payouts.terms-unavailable or commission-payouts.unavailable',
  })
  async remove(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Query('expectedVersion') expectedVersion: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.clear.execute(context, {
      sellerId,
      expectedVersion:
        typeof expectedVersion === 'string' && /^[0-9]{1,9}$/.test(expectedVersion)
          ? Number(expectedVersion)
          : -1,
    });
    logRoute(
      this.#logger,
      'commission-payouts.clear-seller-payout-terms-route',
      context,
      result.ok ? 'cleared' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutTermsBody(result.value);
  }
}

/**
 * A seller's payout holds (package 6b; G2 3.5), for admins: list, place and release. A hold is
 * inserted and released, never edited or deleted. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('commission-payouts')
@RoutePopulation('admin')
@ReadsSession()
@Controller('commission-payouts/admin')
export class AdminPayoutHoldsController {
  readonly #logger = new Logger('AdminPayoutHoldsController');

  constructor(
    private readonly list: ListSellerPayoutHolds,
    private readonly place: PlacePayoutHold,
    private readonly release: ReleasePayoutHold,
  ) {}

  @Get('sellers/:sellerId/payout-holds')
  @ApiOperation({
    summary: "A seller's payout holds (admin)",
    description: 'Needs commission-payouts.settlement.view. Active holds first, newest first.',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: PayoutHoldsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.seller-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.unavailable' })
  async holds(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { sellerId });
    logRoute(
      this.#logger,
      'commission-payouts.list-seller-payout-holds-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { holds: result.value.map(payoutHoldBody) };
  }

  @Post('sellers/:sellerId/payout-holds')
  @ApiOperation({
    summary: 'Place a payout hold (admin)',
    description:
      'Needs commission-payouts.payout-hold.place (protected: a recent second-factor confirmation, refused in a Login-as-Seller session). The reason code is required (admin-review or bank-change); the system places the other reasons. With sellerOrderId the hold covers that seller order only. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: PlacePayoutHoldRequest })
  @ApiCreatedResponse({ type: PayoutHoldBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'commission-payouts.seller-not-found or commission-payouts.seller-order-not-found',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'commission-payouts.unavailable' })
  async placeHold(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['reason', 'sellerOrderId']);
    if (invalid !== null) throw invalid;
    const { reason, sellerOrderId } = requestBody as Record<string, unknown>;
    const result = await this.place.execute(context, { sellerId, sellerOrderId, reason });
    logRoute(
      this.#logger,
      'commission-payouts.place-payout-hold-route',
      context,
      result.ok ? 'placed' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutHoldBody(result.value);
  }

  @Post('payout-holds/:holdId/release')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Release a payout hold (admin)',
    description:
      'Needs commission-payouts.payout-hold.release (protected). Releases any hold, a seller-suspended one included; the system never does. The reason code is required. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'holdId', format: 'uuid' })
  @ApiBody({ type: ReleasePayoutHoldRequest })
  @ApiOkResponse({ type: PayoutHoldBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'commission-payouts.hold-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'commission-payouts.hold-already-released' })
  async releaseHold(
    @Call() context: CallContext,
    @Param('holdId') holdId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['reason']);
    if (invalid !== null) throw invalid;
    const result = await this.release.execute(context, {
      holdId,
      reason: (requestBody as { reason?: unknown }).reason,
    });
    logRoute(
      this.#logger,
      'commission-payouts.release-payout-hold-route',
      context,
      result.ok ? 'released' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return payoutHoldBody(result.value);
  }
}
