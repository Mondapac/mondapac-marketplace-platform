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
import { SetAccountDeletionSettings } from '../application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionSettings } from '../application/use-cases/view-account-deletion-settings.use-case';
import { SETTING_FIELDS } from '../domain/account-deletion-settings';
import {
  AccountDeletionSettingsBody,
  SetAccountDeletionSettingsRequest,
} from './account-deletion.dto';
import { closedBody, closedObject, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The Market's buyer account deletion setting, read and replaced by an admin. Thin adapters: each
 * use case does its work behind its gate. Every answer is `Cache-Control: no-store`; the body
 * (it holds the admin's reason) is never logged.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/account-deletion-settings')
export class AdminAccountDeletionSettingsController {
  readonly #logger = new Logger('AdminAccountDeletionSettingsController');

  constructor(
    private readonly view: ViewAccountDeletionSettings,
    private readonly set: SetAccountDeletionSettings,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The buyer account deletion setting (admin)',
    description:
      'Needs customers.account-deletion-settings.view. Version 0 is the built-in defaults ' +
      '(deletion off, 30 days).',
  })
  @ApiOkResponse({ type: AccountDeletionSettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'customers.view-account-deletion-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Replace the buyer account deletion setting (admin)',
    description:
      'Needs customers.account-deletion-settings.manage (protected). Every field and a reason ' +
      '(1 to 500 characters) are required. expectedVersion is the version the screen read; a ' +
      'different current version answers customers.conflict. The same values again change ' +
      'nothing. Every change is a new version in an insert-only history (with the reason), an ' +
      'audit row and an outbox event. The platform has no step-up rule for admin routes, so ' +
      'none applies.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetAccountDeletionSettingsRequest })
  @ApiOkResponse({ type: AccountDeletionSettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'customers.conflict (another admin saved first)' })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion', 'settings', 'reason']);
    if (invalid !== null) throw invalid;
    const { settings, expectedVersion, reason } = requestBody as {
      settings?: unknown;
      expectedVersion?: unknown;
      reason?: unknown;
    };
    const invalidSettings = closedObject(settings, SETTING_FIELDS, 'settings');
    if (invalidSettings !== null) throw invalidSettings;
    const result = await this.set.execute(context, { settings, expectedVersion, reason });
    this.log(
      'customers.set-account-deletion-settings-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
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
