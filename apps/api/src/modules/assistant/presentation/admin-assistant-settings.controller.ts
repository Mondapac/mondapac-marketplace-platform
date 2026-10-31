import { Body, Controller, Get, HttpCode, Logger, Put, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import {
  changeHistoryBody,
  changeHistoryInputOf,
  lastChangedBody,
} from '../../../platform/audit/change-trail';
import { ChangeHistoryDto } from '../../../platform/audit/change-trail.dto';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SetAssistantSettings } from '../application/use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from '../application/use-cases/view-assistant-settings.use-case';
import { ViewAssistantSettingsHistory } from '../application/use-cases/view-assistant-settings-history.use-case';
import { SETTING_FIELDS } from '../domain/assistant-settings';
import { AssistantSettingsBody, SetAssistantSettingsRequest } from './assistant.dto';
import { closedBody, closedObject, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The Market's buyer assistant settings, read and replaced by an admin. Thin adapters: each use
 * case does its work behind its gate. Every answer is `Cache-Control: no-store`; the body is
 * never logged.
 */
@ApiTags('assistant')
@RoutePopulation('admin')
@ReadsSession()
@Controller('assistant/admin/settings')
export class AdminAssistantSettingsController {
  readonly #logger = new Logger('AdminAssistantSettingsController');

  constructor(
    private readonly view: ViewAssistantSettings,
    private readonly set: SetAssistantSettings,
    private readonly history: ViewAssistantSettingsHistory,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The buyer assistant settings (admin)',
    description:
      'Needs assistant.settings.view. Version 0 is the built-in defaults (assistant off). apiKey ' +
      'says only whether the server has a model API key; the key is never returned. lastChanged ' +
      'says who changed the settings last and when (null while the defaults are in force).',
  })
  @ApiOkResponse({ type: AssistantSettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'assistant.view-assistant-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { ...result.value, lastChanged: lastChangedBody(result.value.lastChanged) };
  }

  @Get('history')
  @ApiOperation({
    summary: 'The changes of the buyer assistant settings (admin)',
    description:
      'Needs assistant.settings.view. Newest first: when, who (a display name, never an email) ' +
      'and the names of the fields that changed, never their values, from the audit log. Paged ' +
      'with after (the next of the previous page) and limit (1 to 50, default 20).',
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
      'assistant.view-assistant-settings-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return changeHistoryBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Replace the buyer assistant settings (admin)',
    description:
      'Needs assistant.settings.manage (protected). Every field is required. expectedVersion is ' +
      'the version the screen read; a different current version answers assistant.conflict. The ' +
      'same settings again change nothing. Every change is a new version in an insert-only ' +
      'history and an audit row. An option not available yet answers validation.failed with ' +
      'code unavailable.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetAssistantSettingsRequest })
  @ApiOkResponse({ type: AssistantSettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'assistant.conflict (another admin saved first; details.lastChanged says who and when)',
  })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion', 'settings']);
    if (invalid !== null) throw invalid;
    const { settings, expectedVersion } = requestBody as {
      settings?: unknown;
      expectedVersion?: unknown;
    };
    const invalidSettings = closedObject(settings, SETTING_FIELDS, 'settings');
    if (invalidSettings !== null) throw invalidSettings;
    const result = await this.set.execute(context, { settings, expectedVersion });
    this.log(
      'assistant.set-assistant-settings-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { ...result.value, lastChanged: lastChangedBody(result.value.lastChanged) };
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
