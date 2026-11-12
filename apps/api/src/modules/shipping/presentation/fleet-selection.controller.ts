import {
  Body,
  Controller,
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
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { changeHistoryBody, changeHistoryInputOf } from '../../../platform/audit/change-trail';
import { ChangeHistoryDto } from '../../../platform/audit/change-trail.dto';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CreateFleetSelectionModel } from '../application/use-cases/create-fleet-selection-model.use-case';
import { SetFleetSelection } from '../application/use-cases/set-fleet-selection.use-case';
import { UpdateFleetSelectionModel } from '../application/use-cases/update-fleet-selection-model.use-case';
import { ViewFleetSelection } from '../application/use-cases/view-fleet-selection.use-case';
import { ViewFleetSelectionHistory } from '../application/use-cases/view-fleet-selection-history.use-case';
import {
  FleetModelBody,
  FleetModelRequest,
  FleetSelectionBody,
  modelBody,
  SaveFleetSelectionRequest,
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
    private readonly save: SetFleetSelection,
    private readonly history: ViewFleetSelectionHistory,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The fleet-selection models, the active model per method and the fleets',
    description:
      'Needs shipping.fleet-selection.view. `active` holds the active model id per delivery ' +
      'method (null: the built-in default order). `fleets` lists every fleet with whether it is ' +
      'on for the Market and its reliability score. `lastChanged` says who changed the page ' +
      'last and when (null until the first change).',
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

  @Get('history')
  @ApiOperation({
    summary: 'The changes of the delivery fleets page',
    description:
      'Needs shipping.fleet-selection.view. Newest first: when, who (a display name, never an ' +
      'email) and the names of the fields that changed, never their values, from the audit log: ' +
      'a model made or edited, the active model of a method, a reliability score. Paged with ' +
      'after (the next of the previous page) and limit (1 to 50, default 20).',
  })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: ChangeHistoryDto })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async changes(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.history.execute(context, changeHistoryInputOf(query));
    this.log(
      'shipping.view-fleet-selection-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return changeHistoryBody(result.value);
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

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Save the fleet-selection page: the active model per method and the fleet reliability',
    description:
      'Needs shipping.fleet-selection.manage (protected). One batch in one transaction: ' +
      '`active` holds the active model id per delivery method (instant, same_day, scheduled; ' +
      'null puts the built-in default order back) and `reliability` the 0 to 100 score per ' +
      'fleet code. `expectedVersion` is the page `version` read (0 before the first save): a ' +
      'stale one answers 409 shipping.fleet-selection-conflict and nothing is written. Each ' +
      'changed item is audited. The answer is the page as saved, with its new version.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SaveFleetSelectionRequest })
  @ApiOkResponse({ type: FleetSelectionBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'shipping.fleet-model-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'shipping.fleet-selection-conflict' })
  async saveSelection(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion', 'active', 'reliability']);
    if (invalid !== null) throw invalid;
    const { expectedVersion, active, reliability } = requestBody as {
      expectedVersion?: unknown;
      active?: unknown;
      reliability?: unknown;
    };
    const result = await this.save.execute(context, { expectedVersion, active, reliability });
    this.log(
      'shipping.set-fleet-selection-route',
      context,
      result.ok ? 'saved' : result.error.code,
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
