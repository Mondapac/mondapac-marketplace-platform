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
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ChangeAiGatewayEmergencyStop } from '../application/use-cases/change-ai-gateway-emergency-stop.use-case';
import { ChangeAiGatewayLimits } from '../application/use-cases/change-ai-gateway-limits.use-case';
import { ChangeAiSetting } from '../application/use-cases/change-ai-setting.use-case';
import { ChangeAiModels } from '../application/use-cases/change-ai-models.use-case';
import { ViewAiModels } from '../application/use-cases/view-ai-models.use-case';
import { ViewAiGatewaySettings } from '../application/use-cases/view-ai-gateway-settings.use-case';
import { ViewAiSettings } from '../application/use-cases/view-ai-settings.use-case';
import { ChangeOfferReviewSettings } from '../application/use-cases/change-offer-review-settings.use-case';
import { ViewOfferReviewSettings } from '../application/use-cases/view-offer-review-settings.use-case';
import { ChangeOfferReviewEmergencyStop } from '../application/use-cases/change-offer-review-emergency-stop.use-case';
import { ViewOfferReviewEmergencyStop } from '../application/use-cases/view-offer-review-emergency-stop.use-case';
import { ChangeCartModeSetting } from '../application/use-cases/change-cart-mode-setting.use-case';
import { ChangeListPagingSetting } from '../application/use-cases/change-list-paging-setting.use-case';
import { ReadListPaging } from '../application/use-cases/read-list-paging.use-case';
import { ViewCartModeSetting } from '../application/use-cases/view-cart-mode-setting.use-case';
import { ViewListPagingSetting } from '../application/use-cases/view-list-paging-setting.use-case';
import { ChangeMonthlyRevenueTargetSetting } from '../application/use-cases/change-monthly-revenue-target-setting.use-case';
import { ViewMonthlyRevenueTargetSetting } from '../application/use-cases/view-monthly-revenue-target-setting.use-case';
import {
  SETTINGS_EMERGENCY_STOP_STEP_UP,
  SETTINGS_OFFER_REVIEW_STEP_UP,
} from '../contracts/step-up';
import { closedBody, refusal } from './http-answers';
import { CART_MODE_CODE } from '../domain/definitions';
import {
  ChangeAiSettingRequest,
  ChangeCartModeRequest,
  ChangeMonthlyRevenueTargetRequest,
  ChangeEmergencyStopRequest,
  ChangeOfferReviewRequest,
  EmergencyStopBody,
  emergencyStopBody,
  ChangeSettingRequest,
  MonthlyRevenueTargetBody,
  monthlyRevenueTargetBody,
  MonthlyRevenueTargetChangeBody,
  monthlyRevenueTargetChangeBody,
  ListPagingBody,
  listPagingBody,
  SettingBody,
  SettingChangeBody,
  settingChangeBody,
  SettingsChangeListBody,
  settingsChangeListBody,
  SettingsListBody,
  settingsListBody,
  AiModelsBody,
  aiModelsBody,
} from './settings.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const STEP_UP_FORBIDDEN =
  'access.denied, request.csrf, second-factor.required (details.actionKey) or ' +
  'second-factor.enrolment-required';

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

/** How a change is reviewed (Admin Inbox › System requests), for every setting write. */
const REVIEWED =
  'Where the Market reviews the marketplace area (see `review` in the view), `note` (1 to 500 ' +
  'characters) is required and the change opens a review request (`request`); a rejected or ' +
  'withdrawn request restores the value before. Elsewhere `note` is ignored.';
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
    private readonly viewAi: ViewAiSettings,
    private readonly changeAi: ChangeAiSetting,
    private readonly viewOfferReview: ViewOfferReviewSettings,
    private readonly changeOfferReview: ChangeOfferReviewSettings,
    private readonly viewTarget: ViewMonthlyRevenueTargetSetting,
    private readonly changeTarget: ChangeMonthlyRevenueTargetSetting,
    private readonly viewEmergencyStop: ViewOfferReviewEmergencyStop,
    private readonly changeEmergencyStop: ChangeOfferReviewEmergencyStop,
    private readonly viewAiGateway: ViewAiGatewaySettings,
    private readonly changeAiGatewayLimits: ChangeAiGatewayLimits,
    private readonly changeAiGatewayStop: ChangeAiGatewayEmergencyStop,
    private readonly viewAiModels: ViewAiModels,
    private readonly changeAiModels: ChangeAiModels,
  ) {}

  @Get('ai-models')
  @ApiOperation({
    summary: 'The AI model choice of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. Per task type (chat, extract, write, vision) the priority ' +
      'list ai-models-<task> (none, or 1 to 3 model families comma-separated, in the order to ' +
      'try) and the saver model ai-saver-<task> (none or one family), and ai-saver-percent (50 ' +
      'to 99, default 80), each with its version; and per task type every model family of the ' +
      'route catalogue with why it cannot be chosen in the Market now.',
  })
  @ApiOkResponse({ type: AiModelsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiModels(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewAiModels.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-ai-models-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiModelsBody(result.value);
  }

  // Every change spends a two-step code in the use case's own unit, after the server checks.
  @Put('ai-models')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the AI model choice of the Market (admin)',
    description:
      'Needs the protected settings.ai-models.manage; refused in an acting-as session. ' +
      '`changes` lists each changed setting once with the version the admin saw. Every change ' +
      'needs a fresh two-step proof of this admin (`POST identity/admin/step-up/verify` for ' +
      'settings.ai-models.change; without it 403 second-factor.required with details.actionKey). ' +
      'Server checks: each family of a changed list is in the route catalogue, once, and usable ' +
      'in the Market for every capability of its task type; a saver model passes the same checks, ' +
      'needs a list and is cheaper than its model 1 (400 validation.failed, details.fields with ' +
      'the path <code>.<index> or <code> and the problem as its code). All or nothing: a stale ' +
      'version is 409 settings.conflict. Each change is audited and, where reviewed, opens a ' +
      'high-risk review request. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeOfferReviewRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putAiModels(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['changes', 'note']);
    if (invalid !== null) throw invalid;
    const { changes, note } = requestBody as { changes?: unknown; note?: unknown };
    const result = await this.changeAiModels.execute(context, { changes, note });
    logRoute(
      this.#logger,
      'settings.change-ai-models-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Get('ai-gateway')
  @ApiOperation({
    summary: 'The AI Gateway settings of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. ai-gateway-emergency-stop (off by default) and the caps ' +
      'ai-cap-market-day, ai-cap-market-month, ai-cap-capability-day, ai-cap-seller-day and ' +
      'ai-cap-guest-day (none by default, else whole US micro-dollars as decimal text; 0 allows ' +
      'nothing), each with its version (0 while the default is in force).',
  })
  @ApiOkResponse({ type: SettingsListBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiGatewaySettings(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewAiGateway.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-ai-gateway-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsListBody(result.value);
  }

  // No @RequiresStepUp on the two AI Gateway writes: only a change that allows more AI spends a
  // two-step code (design section 8), which the use case decides and spends in its own unit.
  @Put('ai-gateway/limits')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the AI caps of the Market (admin)',
    description:
      'Needs the protected settings.ai-gateway.manage; refused in an acting-as session. ' +
      '`changes` lists each changed cap once with the version the admin saw; a value is `none` ' +
      'or whole US micro-dollars (0 to 1000000000000). Raising or lifting any cap needs a fresh ' +
      'two-step proof of this admin (`POST identity/admin/step-up/verify` for ' +
      'settings.ai-gateway-limits.raise; without it 403 second-factor.required with ' +
      'details.actionKey); lowering needs none. All or nothing: a stale version is 409 ' +
      'settings.conflict. Each change is audited and, where reviewed, opens a high-risk review ' +
      'request; a rejected review never raises a cap. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeOfferReviewRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putAiGatewayLimits(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['changes', 'note']);
    if (invalid !== null) throw invalid;
    const { changes, note } = requestBody as { changes?: unknown; note?: unknown };
    const result = await this.changeAiGatewayLimits.execute(context, { changes, note });
    logRoute(
      this.#logger,
      'settings.change-ai-gateway-limits-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Put('ai-gateway/emergency-stop')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Switch the AI emergency stop of the Market on or off (admin)',
    description:
      'Needs the protected settings.ai-gateway.manage; refused in an acting-as session. A note ' +
      'is always required. On: every AI capability of the Market is off from the next call, with ' +
      'no two-step code. Off (AI on again): needs a fresh two-step proof of this admin (`POST ' +
      'identity/admin/step-up/verify` for settings.ai-gateway-emergency-stop.resume; without it ' +
      '403 second-factor.required with details.actionKey). Audited and reviewed at high risk ' +
      'where the area is reviewed; a rejected review never switches it off. A stale version is ' +
      '409 settings.conflict.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeEmergencyStopRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putAiGatewayEmergencyStop(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['value', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { value, expectedVersion, note } = requestBody as Record<string, unknown>;
    const result = await this.changeAiGatewayStop.execute(context, {
      value,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'settings.change-ai-gateway-emergency-stop-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Get('offer-review/emergency-stop')
  @ApiOperation({
    summary: 'Whether the Offer review emergency stop is on (admin)',
    description:
      'Any admin of the Market (the banner on every admin page): on, the version, when it was ' +
      'last switched and the display name of who switched it.',
  })
  @ApiOkResponse({ type: EmergencyStopBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async emergencyStop(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewEmergencyStop.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-offer-review-emergency-stop-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return emergencyStopBody(result.value);
  }

  @Put('offer-review/emergency-stop')
  @HttpCode(200)
  @RequiresStepUp(SETTINGS_EMERGENCY_STOP_STEP_UP)
  @ApiOperation({
    summary: 'Switch the Offer review emergency stop on or off (admin)',
    description:
      'Needs the protected settings.offer-review.emergency-stop and a fresh two-step proof of ' +
      'this admin (`POST identity/admin/step-up/verify` for ' +
      'settings.offer-review-emergency-stop.change; without it 403 second-factor.required with ' +
      'details.actionKey); refused in an acting-as session. A rejected review never switches it ' +
      'off. A note is always required. Live at once: while on, every new ' +
      'Offer of the Market waits for an admin; live Offers stay live. Audited, and reviewed at ' +
      'high risk where the area is reviewed. A stale version is 409 settings.conflict.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeEmergencyStopRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putEmergencyStop(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['value', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { value, expectedVersion, note } = requestBody as Record<string, unknown>;
    const result = await this.changeEmergencyStop.execute(context, {
      value,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'settings.change-offer-review-emergency-stop-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Get('monthly-revenue-target')
  @ApiOperation({
    summary: 'The monthly revenue target of the Market (admin)',
    description:
      'Needs settings.monthly-revenue-target.view. The GMV with tax the Market aims for in each ' +
      "calendar month of its zone, in the Market's currency (minor units as a string); null while " +
      'none is set (version 0). It stays in force for every month until changed.',
  })
  @ApiOkResponse({ type: MonthlyRevenueTargetBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async monthlyRevenueTarget(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewTarget.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-monthly-revenue-target-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    const [view] = result.value;
    if (view === undefined) throw refusal({ code: 'internal' }, context, this.#logger);
    return monthlyRevenueTargetBody(view);
  }

  @Put('monthly-revenue-target')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set or clear the monthly revenue target of the Market (admin)',
    description:
      'Needs settings.monthly-revenue-target.manage; refused in an acting-as session. `target` ' +
      "is minor units above zero (at most 15 digits) in the Market's own currency, or null to " +
      'clear it. The body carries the version the admin saw: a stale edit is 409 ' +
      'settings.conflict. Audited with the target before and after; asking for the target ' +
      'already in force changes nothing. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeMonthlyRevenueTargetRequest })
  @ApiOkResponse({ type: MonthlyRevenueTargetChangeBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: target, target.amount, target.currency, ...)',
  })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putMonthlyRevenueTarget(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['target', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { target, expectedVersion, note } = requestBody as {
      target?: unknown;
      expectedVersion?: unknown;
      note?: unknown;
    };
    const result = await this.changeTarget.execute(context, { target, expectedVersion, note });
    logRoute(
      this.#logger,
      'settings.change-monthly-revenue-target-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return monthlyRevenueTargetChangeBody(result.value);
  }

  @Get('offer-review')
  @ApiOperation({
    summary: 'The Offer review policy of the Market (admin)',
    description:
      'Needs settings.offer-review.view. offer-review-mode (risk-based by default), ' +
      'offer-review-probation-offers (10), offer-review-reference-sellers (3), ' +
      'offer-review-price-band (50, percent), offer-review-sampling (5, percent) and ' +
      'offer-review-certificate-badges (review), offer-review-backlog-count (50) and ' +
      'offer-review-backlog-hours (24, business hours), each with its version (0 while the default is ' +
      'in force). Numbers are decimal text.',
  })
  @ApiOkResponse({ type: SettingsListBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async offerReviewSettings(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewOfferReview.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-offer-review-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsListBody(result.value);
  }

  @Put('offer-review')
  @HttpCode(200)
  @RequiresStepUp(SETTINGS_OFFER_REVIEW_STEP_UP)
  @ApiOperation({
    summary: 'Change the Offer review policy of the Market (admin)',
    description:
      'Needs settings.offer-review.manage and a fresh two-step proof of this admin ' +
      '(`POST identity/admin/step-up/verify` for settings.offer-review.change; without it 403 ' +
      'second-factor.required with details.actionKey); refused in an acting-as session. `changes` lists each ' +
      'changed setting once with the version the admin saw. All or nothing: a stale version of ' +
      'any of them is 409 settings.conflict and nothing is saved. Each change is audited and, ' +
      'where reviewed, opens its own review request. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeOfferReviewRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putOfferReview(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['changes', 'note']);
    if (invalid !== null) throw invalid;
    const { changes, note } = requestBody as { changes?: unknown; note?: unknown };
    const result = await this.changeOfferReview.execute(context, { changes, note });
    logRoute(
      this.#logger,
      'settings.change-offer-review-settings-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Get('ai')
  @ApiOperation({
    summary: 'The AI settings of the Market (admin)',
    description:
      'Needs settings.ai.view. ai-description-writer (off by default) and ' +
      'ai-description-writer-tier (fast by default), each with its version (0 while the default ' +
      'is in force). The provider, model ids and key are server configuration, not settings.',
  })
  @ApiOkResponse({ type: SettingsListBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiSettings(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewAi.execute(context, {});
    logRoute(
      this.#logger,
      'settings.view-ai-settings-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsListBody(result.value);
  }

  @Put('ai')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change one AI setting of the Market (admin)',
    description:
      'Needs the protected settings.ai.manage; refused in an acting-as session. The body names ' +
      'the setting and carries the version the admin saw: a stale edit is 409 settings.conflict. ' +
      'Audited with the previous and new value; asking for the value in force changes nothing. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeAiSettingRequest })
  @ApiOkResponse({ type: SettingChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putAiSetting(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['code', 'value', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { code, value, expectedVersion, note } = requestBody as {
      code?: unknown;
      value?: unknown;
      expectedVersion?: unknown;
      note?: unknown;
    };
    const result = await this.changeAi.execute(context, { code, value, expectedVersion, note });
    logRoute(
      this.#logger,
      'settings.change-ai-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingChangeBody(result.value);
  }

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
      'already in force changes nothing. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeSettingRequest })
  @ApiOkResponse({ type: SettingChangeBody })
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
    const invalid = closedBody(request, requestBody, ['code', 'value', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { code, value, expectedVersion, note } = requestBody as {
      code?: unknown;
      value?: unknown;
      expectedVersion?: unknown;
      note?: unknown;
    };
    const result = await this.change.execute(context, { code, value, expectedVersion, note });
    logRoute(
      this.#logger,
      'settings.change-list-paging-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingChangeBody(result.value);
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
      'and new value; asking for the value already in force changes nothing. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeCartModeRequest })
  @ApiOkResponse({ type: SettingChangeBody })
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
    const invalid = closedBody(request, requestBody, ['value', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { value, expectedVersion, note } = requestBody as {
      value?: unknown;
      expectedVersion?: unknown;
      note?: unknown;
    };
    const result = await this.changeCartMode.execute(context, {
      code: CART_MODE_CODE,
      value,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'settings.change-cart-mode-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingChangeBody(result.value);
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
