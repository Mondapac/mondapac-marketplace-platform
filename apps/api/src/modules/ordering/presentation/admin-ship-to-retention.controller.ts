import { Body, Controller, Get, HttpCode, Logger, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminSetShipToRetention } from '../application/use-cases/admin-set-ship-to-retention.use-case';
import { AdminViewShipToRetention } from '../application/use-cases/admin-view-ship-to-retention.use-case';
import { closedBody, refusal } from './http-answers';
import {
  SHIP_TO_RETENTION_BODY_KEYS,
  ShipToRetentionBody,
  ShipToRetentionRequestBody,
  shipToRetentionBody,
} from './ship-to-retention.dto';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

/**
 * The Market's ship-to retention (owner decision 2026-11-15): whether, and how many months after
 * its seller orders are settled, the sealed delivery address of an order is deleted. The controller authenticates only;
 * the use cases need `ordering.ship-to-retention.view` or `ordering.ship-to-retention.manage`.
 * Every response is `Cache-Control: no-store`.
 */
@ApiTags('ordering')
@RoutePopulation('admin')
@ReadsSession()
@Controller('ordering/admin/ship-to-retention')
export class AdminShipToRetentionController {
  readonly #logger = new Logger('AdminShipToRetentionController');

  constructor(
    private readonly view: AdminViewShipToRetention,
    private readonly set: AdminSetShipToRetention,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The ship-to retention of the Market (admin)',
    description: 'Needs ordering.ship-to-retention.view. Never set: off, 24 months, version 0.',
  })
  @ApiOkResponse({ type: ShipToRetentionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async get(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'ordering.admin-view-ship-to-retention-route',
      context,
      result.ok ? 'ok' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return shipToRetentionBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @RequiresStepUp('ordering.ship-to-retention.change')
  @ApiOperation({
    summary: 'Set the ship-to retention of the Market (admin)',
    description:
      'Needs ordering.ship-to-retention.manage (protected) and a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for ordering.ship-to-retention.change; without ' +
      'it 403 second-factor.required with details.actionKey). Refused in an acting-as session. ' +
      'Switched on, a daily job deletes for good the sealed delivery address (address, phone, ' +
      'buyer note) of every order whose seller orders are all settled, the last at least `months` ' +
      'months ago: delivered, shipped and never delivered, cancelled with the order, or refunded ' +
      'in full while still to ship. An order with a seller order still to ship and not refunded ' +
      'in full is not touched. Audited with before and after. ' +
      'expectedVersion is the version read (0 when never set); 409 conflict.retry when another ' +
      'admin changed it first.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ShipToRetentionRequestBody })
  @ApiOkResponse({ type: ShipToRetentionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required (details.actionKey) or ' +
      'second-factor.enrolment-required',
  })
  @ApiConflictResponse({ ...ERROR, description: 'conflict.retry' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, SHIP_TO_RETENTION_BODY_KEYS);
    if (invalid !== null) throw invalid;
    const { enabled, months, expectedVersion } = body as Record<string, unknown>;
    const result = await this.set.execute(context, { enabled, months, expectedVersion });
    this.log(
      'ordering.admin-set-ship-to-retention-route',
      context,
      result.ok ? 'saved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return shipToRetentionBody(result.value);
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
