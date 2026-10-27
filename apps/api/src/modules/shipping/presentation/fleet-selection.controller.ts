import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
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
import { ActivateFleetSelectionModel } from '../application/use-cases/activate-fleet-selection-model.use-case';
import { CreateFleetSelectionModel } from '../application/use-cases/create-fleet-selection-model.use-case';
import { SetFleetReliability } from '../application/use-cases/set-fleet-reliability.use-case';
import { UpdateFleetSelectionModel } from '../application/use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelection } from '../application/use-cases/view-fleet-selection.use-case';
import {
  ActivateModelRequest,
  FleetModelBody,
  FleetModelRequest,
  FleetSelectionBody,
  modelBody,
  ReliabilityRequest,
  selectionBody,
  UpdateFleetModelRequest,
} from './fleet-selection.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * Fleet selection for admins (delivery models, package 3): which fleet carries a seller order is
 * decided by the active model of the Market and the buyer's delivery method. Thin adapters: every
 * use case does its work behind its gate (`shipping.fleet-selection.view` and `.manage`). Every
 * answer is `Cache-Control: no-store`.
 */
@ApiTags('shipping')
@RoutePopulation('admin')
@ReadsSession()
@Controller('shipping/admin/fleet-selection')
export class FleetSelectionController {
  readonly #logger = new Logger('FleetSelectionController');

  constructor(
    private readonly view: ViewFleetSelection,
    private readonly create: CreateFleetSelectionModel,
    private readonly update: UpdateFleetSelectionModel,
    private readonly activate: ActivateFleetSelectionModel,
    private readonly reliability: SetFleetReliability,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The fleet-selection models, the active model per method and the fleets',
    description:
      'Needs shipping.fleet-selection.view. `active` holds the active model id per delivery ' +
      'method (null: the built-in default order). `fleets` lists every fleet with whether it is ' +
      'on for the Market and its reliability score.',
  })
  @ApiOkResponse({ type: FleetSelectionBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async read(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'shipping.view-fleet-selection-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return selectionBody(result.value);
  }

  @Post('models')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Define a fleet-selection model',
    description:
      'Needs shipping.fleet-selection.manage (protected). Kinds: cheapest (lowest quote), ' +
      'weighted (weights over price, ETA and reliability) and fixed_priority (an ordered fleet ' +
      'list). Ties go to Mondapac Drive. The change is audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: FleetModelRequest })
  @ApiCreatedResponse({ type: FleetModelBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'shipping.fleet-model-name-taken' })
  async createModel(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['name', 'rule']);
    if (invalid !== null) throw invalid;
    const { name, rule } = requestBody as { name?: unknown; rule?: unknown };
    const result = await this.create.execute(context, { name, rule });
    this.log(
      'shipping.create-fleet-selection-model-route',
      context,
      result.ok ? 'created' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return modelBody(result.value);
  }

  @Put('models/:modelId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Edit a fleet-selection model',
    description:
      'Needs shipping.fleet-selection.manage (protected). `expectedVersion` is the version read: ' +
      'a stale one answers 409 shipping.fleet-model-conflict. The edit is audited. An active ' +
      'model takes effect on the next booking.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'modelId', format: 'uuid' })
  @ApiBody({ type: UpdateFleetModelRequest })
  @ApiOkResponse({ type: FleetModelBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.fleet-model-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'shipping.fleet-model-name-taken or shipping.fleet-model-conflict',
  })
  async updateModel(
    @Call() context: CallContext,
    @Param('modelId') modelId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['name', 'rule', 'expectedVersion']);
    if (invalid !== null) throw invalid;
    const { name, rule, expectedVersion } = requestBody as {
      name?: unknown;
      rule?: unknown;
      expectedVersion?: unknown;
    };
    const result = await this.update.execute(context, { modelId, name, rule, expectedVersion });
    this.log(
      'shipping.update-fleet-selection-model-route',
      context,
      result.ok ? 'updated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return modelBody(result.value);
  }

  @Put('active/:method')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pick the active model of a delivery method',
    description:
      'Needs shipping.fleet-selection.manage (protected). `method` is instant, same_day or ' +
      'scheduled. A null modelId puts the built-in default order back. The change is audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'method', enum: ['instant', 'same_day', 'scheduled'] })
  @ApiBody({ type: ActivateModelRequest })
  @ApiOkResponse({ type: FleetSelectionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.fleet-model-not-found' })
  async activateModel(
    @Call() context: CallContext,
    @Param('method') method: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['modelId']);
    if (invalid !== null) throw invalid;
    const { modelId } = requestBody as { modelId?: unknown };
    const result = await this.activate.execute(context, { method, modelId: modelId ?? undefined });
    this.log(
      'shipping.activate-fleet-selection-model-route',
      context,
      result.ok ? 'activated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return selectionBody(result.value);
  }

  @Put('fleets/:fleet/reliability')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the reliability score of a fleet',
    description:
      'Needs shipping.fleet-selection.manage (protected). A whole number from 0 to 100, an ' +
      'input of the weighted kind. It is set by an admin for now; a score computed from delivery ' +
      'history comes later. The change is audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({
    name: 'fleet',
    enum: ['mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test'],
  })
  @ApiBody({ type: ReliabilityRequest })
  @ApiOkResponse({ type: FleetSelectionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  async setReliability(
    @Call() context: CallContext,
    @Param('fleet') fleet: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['score']);
    if (invalid !== null) throw invalid;
    const { score } = requestBody as { score?: unknown };
    const result = await this.reliability.execute(context, { fleet, score });
    this.log(
      'shipping.set-fleet-reliability-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return selectionBody(result.value);
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
