import { Body, Controller, Get, HttpCode, Logger, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
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
import { ChangeCartModeSetting } from '../application/use-cases/change-cart-mode-setting.use-case';
import { ChangeListPagingSetting } from '../application/use-cases/change-list-paging-setting.use-case';
import { ReadListPaging } from '../application/use-cases/read-list-paging.use-case';
import { ViewCartModeSetting } from '../application/use-cases/view-cart-mode-setting.use-case';
import { ViewListPagingSetting } from '../application/use-cases/view-list-paging-setting.use-case';
import { closedBody, refusal } from './http-answers';
import { CART_MODE_CODE } from '../domain/definitions';
import {
  ChangeCartModeRequest,
  ChangeSettingRequest,
  ListPagingBody,
  listPagingBody,
  SettingBody,
  settingBody,
  SettingsListBody,
  settingsListBody,
} from './settings.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  // Ids and codes only.
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/** The editable Market settings, for admins. Every answer is `Cache-Control: no-store`. */
@ApiTags('settings')
@RoutePopulation('admin')
@ReadsSession()
@Controller('settings/admin')
export class AdminSettingsController {
  readonly #logger = new Logger('AdminSettingsController');

  constructor(
    private readonly view: ViewListPagingSetting,
    private readonly change: ChangeListPagingSetting,
    private readonly listPaging: ReadListPaging,
    private readonly viewCartMode: ViewCartModeSetting,
    private readonly changeCartMode: ChangeCartModeSetting,
  ) {}

  @Get('market-settings')
  @ApiOperation({
    summary: 'Every editable setting of the Market (admin)',
    description: 'Needs settings.list-paging.view. A setting with no change has version 0.',
  })
  @ApiOkResponse({ type: SettingsListBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async list(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-list-paging-setting-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsListBody(result.value);
  }

  @Put('market-settings')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change one editable setting of the Market (admin)',
    description:
      'Needs settings.list-paging.manage; refused in an acting-as session. The body carries the ' +
      'version the admin saw: a stale edit is 409 settings.conflict. Audited; asking for the value ' +
      'already in force changes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeSettingRequest })
  @ApiOkResponse({ type: SettingBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['code', 'value', 'expectedVersion']);
    if (invalid !== null) throw invalid;
    const { code, value, expectedVersion } = requestBody as {
      code?: unknown;
      value?: unknown;
      expectedVersion?: unknown;
    };
    const result = await this.change.execute(context, { code, value, expectedVersion });
    logRoute(
      this.#logger,
      'settings.change-list-paging-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingBody(result.value);
  }

  @Get('cart-mode')
  @ApiOperation({
    summary: 'The Cart mode setting of the Market (admin)',
    description:
      'Needs settings.cart-mode.view. multi-store (default) or single-store; version 0 while the ' +
      'default is in force. Only stores the choice; cart behaviour is not changed by it here.',
  })
  @ApiOkResponse({ type: SettingBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async cartMode(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewCartMode.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-cart-mode-setting-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsListBody(result.value).settings[0];
  }

  @Put('cart-mode')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the Cart mode setting of the Market (admin)',
    description:
      'Needs settings.cart-mode.manage; refused in an acting-as session. The body carries the ' +
      'version the admin saw: a stale edit is 409 settings.conflict. Audited with the previous ' +
      'and new value; asking for the value already in force changes nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeCartModeRequest })
  @ApiOkResponse({ type: SettingBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putCartMode(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['value', 'expectedVersion']);
    if (invalid !== null) throw invalid;
    const { value, expectedVersion } = requestBody as {
      value?: unknown;
      expectedVersion?: unknown;
    };
    const result = await this.changeCartMode.execute(context, {
      code: CART_MODE_CODE,
      value,
      expectedVersion,
    });
    logRoute(
      this.#logger,
      'settings.change-cart-mode-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingBody(result.value);
  }

  @Get('list-paging')
  @ApiOperation({
    summary: 'How lists page in the admin panel',
    description: 'Any signed-in admin. An unreadable store answers prev-next.',
  })
  @ApiOkResponse({ type: ListPagingBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  async paging(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.listPaging.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return listPagingBody(result.value);
  }
}

/** How lists page, for the seller panel. */
@ApiTags('settings')
@RoutePopulation('seller')
@ReadsSession()
@Controller('settings/seller')
export class SellerSettingsController {
  readonly #logger = new Logger('SellerSettingsController');

  constructor(private readonly listPaging: ReadListPaging) {}

  @Get('list-paging')
  @ApiOperation({
    summary: 'How lists page in the seller panel',
    description: 'Any signed-in seller user. An unreadable store answers prev-next.',
  })
  @ApiOkResponse({ type: ListPagingBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  async paging(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.listPaging.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return listPagingBody(result.value);
  }
}
