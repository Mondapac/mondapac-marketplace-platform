import { Body, Controller, Get, HttpCode, Logger, Param, Put, Req, Res } from '@nestjs/common';
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
import { SetDeliverySettings } from '../application/use-cases/set-delivery-settings.use-case';
import { SetSellerDeliveryMethods } from '../application/use-cases/set-seller-delivery-methods.use-case';
import { ViewDeliverySettings } from '../application/use-cases/view-delivery-settings.use-case';
import { ViewSellerDeliveryMethods } from '../application/use-cases/view-seller-delivery-methods.use-case';
import {
  DeliverySettingsBody,
  DeliverySettingsRequest,
  SellerDeliveryMethodsBody,
  SellerDeliveryMethodsRequest,
  sellerMethodsBody,
  settingsBody,
} from './delivery-settings.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The delivery settings for admins (delivery models, package 4): which delivery methods the
 * Market has on, the same-day cut-off, the scheduled days and window, the margin on a fleet's
 * quote, and the methods each seller supports. Thin adapters: every use case does its work behind
 * its gate (`shipping.delivery-settings.view` and `.manage`). Every answer is `Cache-Control: no-store`.
 */
@ApiTags('shipping')
@RoutePopulation('admin')
@ReadsSession()
@Controller('shipping/admin')
export class DeliverySettingsController {
  readonly #logger = new Logger('DeliverySettingsController');

  constructor(
    private readonly view: ViewDeliverySettings,
    private readonly set: SetDeliverySettings,
    private readonly viewSeller: ViewSellerDeliveryMethods,
    private readonly setSeller: SetSellerDeliveryMethods,
  ) {}

  @Get('delivery-settings')
  @ApiOperation({
    summary: 'The delivery settings of the Market',
    description:
      'Needs shipping.delivery-settings.view. Until the first save the defaults apply: every ' +
      'method on, a 12:00 same-day cut-off, 7 days ahead, 120-minute windows, no margin (version 0).',
  })
  @ApiOkResponse({ type: DeliverySettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async read(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'shipping.view-delivery-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }

  @Put('delivery-settings')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the delivery settings of the Market',
    description:
      'Needs shipping.delivery-settings.manage (protected). The whole set is sent; ' +
      '`expectedVersion` is the version read (0 before the first save) and a stale one answers ' +
      '409 shipping.delivery-settings-conflict. A method that is off is unavailable for every ' +
      'seller. The change is audited and applies to orders placed after it.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: DeliverySettingsRequest })
  @ApiOkResponse({ type: DeliverySettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'shipping.delivery-settings-conflict' })
  async save(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'enabled',
      'sameDayCutoff',
      'scheduledDaysAhead',
      'scheduledWindowMinutes',
      'readyPrepMinutes',
      'margin',
      'roundingStepMinor',
      'expectedVersion',
    ]);
    if (invalid !== null) throw invalid;
    const result = await this.set.execute(context, requestBody);
    this.log(
      'shipping.set-delivery-settings-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }

  @Get('sellers/:sellerId/delivery-methods')
  @ApiOperation({
    summary: 'The delivery methods a seller supports (admin)',
    description:
      'Needs shipping.delivery-settings.view. A seller supports every method until an admin ' +
      'takes one away; the Market switch comes first (`platformEnabled`).',
  })
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiOkResponse({ type: SellerDeliveryMethodsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.seller-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'shipping.unavailable' })
  async readSeller(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewSeller.execute(context, { sellerId });
    this.log(
      'shipping.view-seller-delivery-methods-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerMethodsBody(result.value);
  }

  @Put('sellers/:sellerId/delivery-methods')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the delivery methods a seller supports (admin)',
    description:
      'Needs shipping.delivery-settings.manage (protected). `supported` lists the methods the ' +
      'seller keeps; the rest are taken away (for example a seller without the capacity for ' +
      'instant delivery). The change is audited and applies to orders placed after it.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'sellerId', format: 'uuid' })
  @ApiBody({ type: SellerDeliveryMethodsRequest })
  @ApiOkResponse({ type: SellerDeliveryMethodsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.seller-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'shipping.unavailable' })
  async saveSeller(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['supported']);
    if (invalid !== null) throw invalid;
    const { supported } = requestBody as { supported?: unknown };
    const result = await this.setSeller.execute(context, { sellerId, supported });
    this.log(
      'shipping.set-seller-delivery-methods-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return sellerMethodsBody(result.value);
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
