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
import { ActivateTaxStrategy } from '../application/use-cases/activate-tax-strategy.use-case';
import { CreateTaxStrategy } from '../application/use-cases/create-tax-strategy.use-case';
import { DeleteTaxStrategy } from '../application/use-cases/delete-tax-strategy.use-case';
import { ListTaxStrategies } from '../application/use-cases/list-tax-strategies.use-case';
import { UpdateTaxStrategy } from '../application/use-cases/update-tax-strategy.use-case';
import { closedBody, refusal } from './http-answers';
import {
  ActivateStrategyRequest,
  StrategyBody,
  StrategyListBody,
  StrategyRequest,
  strategyBody,
  strategyListBody,
} from './tax.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const STRATEGY_FIELDS = ['name', 'kind', 'rateBps', 'defaultRateBps', 'categoryRatesBps'];

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The Market's tax strategies, for admins: how the tax of an order line is worked out and which
 * strategy is in force. Thin adapters: each use case does its work behind its gate. Every answer
 * is `Cache-Control: no-store`.
 */
@ApiTags('tax')
@RoutePopulation('admin')
@ReadsSession()
@Controller('tax/admin/strategies')
export class AdminTaxController {
  readonly #logger = new Logger('AdminTaxController');

  constructor(
    private readonly list: ListTaxStrategies,
    private readonly create: CreateTaxStrategy,
    private readonly update: UpdateTaxStrategy,
    private readonly remove: DeleteTaxStrategy,
    private readonly activate: ActivateTaxStrategy,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The Market's tax strategies (admin)",
    description:
      'Needs tax.strategy.view. The built-in rate, the active strategy and every strategy, newest first.',
  })
  @ApiOkResponse({ type: StrategyListBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'tax.unavailable' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {});
    logRoute(
      this.#logger,
      'tax.list-strategies-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return strategyListBody(result.value);
  }

  @Post()
  @ApiOperation({
    summary: 'Define a tax strategy (admin)',
    description:
      'Needs tax.strategy.manage (protected). The new strategy is not active until it is activated. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: StrategyRequest })
  @ApiCreatedResponse({ type: StrategyBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'tax.unavailable' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, STRATEGY_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.create.execute(context, requestBody);
    logRoute(
      this.#logger,
      'tax.create-strategy-route',
      context,
      result.ok ? 'created' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return strategyBody(result.value);
  }

  @Post('active')
  @HttpCode(200)
  @ApiOperation({
    summary: "Pick the Market's active tax strategy (admin)",
    description:
      'Needs tax.strategy.manage (protected). Applies to orders placed after the change; placed ' +
      'orders keep the tax frozen on them. `strategyId: null` puts the Market back on the ' +
      'built-in strategy. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ActivateStrategyRequest })
  @ApiOkResponse({ type: StrategyListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'tax.strategy-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'tax.unavailable' })
  async setActive(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['strategyId']);
    if (invalid !== null) throw invalid;
    const strategyId = (requestBody as { strategyId?: unknown }).strategyId;
    const result = await this.activate.execute(context, { strategyId });
    logRoute(
      this.#logger,
      'tax.activate-strategy-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return strategyListBody(result.value);
  }

  @Put(':strategyId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change a tax strategy (admin)',
    description:
      'Needs tax.strategy.manage (protected). Replaces the name and parameters; also allowed ' +
      'while the strategy is active. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'strategyId', format: 'uuid' })
  @ApiBody({ type: StrategyRequest })
  @ApiOkResponse({ type: StrategyBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'tax.strategy-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'tax.unavailable' })
  async put(
    @Call() context: CallContext,
    @Param('strategyId') strategyId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, STRATEGY_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.update.execute(context, { strategyId, body: requestBody });
    logRoute(
      this.#logger,
      'tax.update-strategy-route',
      context,
      result.ok ? 'updated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return strategyBody(result.value);
  }

  @Delete(':strategyId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove an inactive tax strategy (admin)',
    description:
      'Needs tax.strategy.manage (protected). The active strategy cannot be removed. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'strategyId', format: 'uuid' })
  @ApiOkResponse({ schema: { type: 'object', properties: { deleted: { type: 'boolean' } } } })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'tax.strategy-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'tax.strategy-active' })
  async delete(
    @Call() context: CallContext,
    @Param('strategyId') strategyId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, { strategyId });
    logRoute(
      this.#logger,
      'tax.delete-strategy-route',
      context,
      result.ok ? 'deleted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
