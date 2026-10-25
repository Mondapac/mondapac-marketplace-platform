import { Body, Controller, Get, HttpCode, Logger, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
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
import { SetWalletStatus } from '../application/use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from '../application/use-cases/view-my-history.use-case';
import { ViewMyWallet } from '../application/use-cases/view-my-wallet.use-case';
import { ViewWalletSettings } from '../application/use-cases/view-wallet-settings.use-case';
import {
  HistoryBody,
  historyBody,
  MyWalletBody,
  myWalletBody,
  SetSettingsRequest,
  SettingsBody,
  settingsBody,
} from './wallet.dto';
import { closedBody, parseLimit, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The signed-in customer's own wallet. Thin adapters: the customer comes from the session, never
 * from the request. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('wallet')
@RoutePopulation('customer')
@ReadsSession()
@Controller('wallet/me')
export class CustomerWalletController {
  readonly #logger = new Logger('CustomerWalletController');

  constructor(
    private readonly viewWallet: ViewMyWallet,
    private readonly viewHistory: ViewMyHistory,
  ) {}

  @Get()
  @ApiOperation({
    summary: "The customer's wallet balance and credit expiring soon",
    description: 'Answers wallet.disabled (404) while the wallet is off in the Market.',
  })
  @ApiOkResponse({ type: MyWalletBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'wallet.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'wallet.unavailable' })
  async me(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewWallet.execute(context, {});
    logRoute(
      this.#logger,
      'wallet.view-my-wallet-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return myWalletBody(result.value);
  }

  @Get('history')
  @ApiOperation({ summary: "The customer's wallet history, newest first" })
  @ApiQuery({ name: 'cursor', required: false, description: 'The `nextCursor` of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100; default 20.' })
  @ApiOkResponse({ type: HistoryBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'wallet.disabled' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'wallet.unavailable' })
  async history(
    @Call() context: CallContext,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewHistory.execute(context, { cursor, limit: parseLimit(limit) });
    logRoute(
      this.#logger,
      'wallet.view-my-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return historyBody(result.value);
  }
}

/** The wallet switch of the Market, for admins. */
@ApiTags('wallet')
@RoutePopulation('admin')
@ReadsSession()
@Controller('wallet/admin/settings')
export class AdminWalletController {
  readonly #logger = new Logger('AdminWalletController');

  constructor(
    private readonly view: ViewWalletSettings,
    private readonly set: SetWalletStatus,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The wallet state of the Market (admin)',
    description: 'Needs wallet.settings.view. No row means off.',
  })
  @ApiOkResponse({ type: SettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async get(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    logRoute(
      this.#logger,
      'wallet.view-wallet-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Move the wallet of the Market to off, active, paused or frozen (admin)',
    description:
      'Needs wallet.settings.manage (protected); refused in an acting-as ' +
      'session. Audited with before and after. Asking for the state the Market is in changes ' +
      'nothing. Back to off is refused once the Market has any journal (use paused). Balances and ' +
      'lots are never removed or zeroed by this call.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSettingsRequest })
  @ApiOkResponse({ type: SettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied or request.csrf',
  })
  @ApiConflictResponse({ ...ERROR, description: 'wallet.cannot-turn-off-with-history' })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['status', 'reasonCode']);
    if (invalid !== null) throw invalid;
    const { status, reasonCode } = requestBody as { status?: unknown; reasonCode?: unknown };
    const result = await this.set.execute(context, { status, reasonCode });
    logRoute(
      this.#logger,
      'wallet.set-wallet-status-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsBody(result.value);
  }
}
