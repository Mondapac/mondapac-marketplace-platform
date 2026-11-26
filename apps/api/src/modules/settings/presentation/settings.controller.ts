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
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
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
import { ChangeAiCapabilities } from '../application/use-cases/change-ai-capabilities.use-case';
import { RevertAiGatewaySetting } from '../application/use-cases/revert-ai-gateway-setting.use-case';
import { RevertAiModelsSetting } from '../application/use-cases/revert-ai-models-setting.use-case';
import { ViewAiGatewayHistory } from '../application/use-cases/view-ai-gateway-history.use-case';
import { ViewAiModelsHistory } from '../application/use-cases/view-ai-models-history.use-case';
import { ViewAiModels } from '../application/use-cases/view-ai-models.use-case';
import { CancelAiEvaluation } from '../application/use-cases/cancel-ai-evaluation.use-case';
import { EstimateAiEvaluation } from '../application/use-cases/estimate-ai-evaluation.use-case';
import { RunAiEvaluation } from '../application/use-cases/run-ai-evaluation.use-case';
import { RunAiPlayground } from '../application/use-cases/run-ai-playground.use-case';
import { ViewAiEvaluation } from '../application/use-cases/view-ai-evaluation.use-case';
import { ViewAiEvaluations } from '../application/use-cases/view-ai-evaluations.use-case';
import { ViewAiPlaygroundSamples } from '../application/use-cases/view-ai-playground-samples.use-case';
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
  SETTINGS_AI_EVALUATION_STEP_UP,
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
  RevertSettingRequest,
  SettingHistoryBody,
  settingHistoryBody,
  AiEvaluationCancelledBody,
  AiEvaluationEstimateBody,
  aiEvaluationEstimateBody,
  AiEvaluationQueuedBody,
  AiEvaluationRunDetailBody,
  aiEvaluationRunDetailBody,
  AiEvaluationRunListBody,
  aiEvaluationRunListBody,
  AiPlaygroundBody,
  aiPlaygroundBody,
  AiPlaygroundSamplesBody,
  aiPlaygroundSamplesBody,
  RunAiEvaluationRequest,
  RunAiPlaygroundRequest,
} from './settings.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const STEP_UP_FORBIDDEN =
  'access.denied, request.csrf, second-factor.required (details.actionKey) or ' +
  'second-factor.enrolment-required';

const outcomeOf = (result: { ok: boolean; error?: { code: string } }): string =>
  result.ok ? 'done' : (result.error?.code ?? 'failed');

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  // Ids and codes only.
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/** A `limit` query as a number when it is plain digits; anything else reaches the use case as is. */
const limitOf = (limit: unknown): unknown =>
  typeof limit === 'string' && /^[0-9]{1,3}$/.test(limit) ? Number(limit) : limit;

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
    private readonly viewEvaluations: ViewAiEvaluations,
    private readonly viewEvaluation: ViewAiEvaluation,
    private readonly estimateEvaluation: EstimateAiEvaluation,
    private readonly runEvaluation: RunAiEvaluation,
    private readonly cancelEvaluation: CancelAiEvaluation,
    private readonly viewPlaygroundSamples: ViewAiPlaygroundSamples,
    private readonly runPlayground: RunAiPlayground,
    private readonly changeAiCapabilities: ChangeAiCapabilities,
    private readonly viewAiGatewayHistory: ViewAiGatewayHistory,
    private readonly viewAiModelsHistory: ViewAiModelsHistory,
    private readonly revertAiGateway: RevertAiGatewaySetting,
    private readonly revertAiModels: RevertAiModelsSetting,
  ) {}

  // AI Gateway G4c: evaluation runs and the playground (design section 8, Tab 1). The fixed paths
  // (estimate) come before `:runId`, so Nest never reads them as a run id.
  @Get('ai-models/evaluations')
  @ApiOperation({
    summary: 'The AI evaluation runs of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. Newest first, 20 a page; `family` keeps one model ' +
      "family's runs and `cursor` is the `next` of the page before. Codes, numbers and ids only.",
  })
  @ApiQuery({ name: 'family', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: AiEvaluationRunListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiEvaluations(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('family') family?: unknown,
    @Query('cursor') cursor?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewEvaluations.execute(context, { family, cursor });
    logRoute(this.#logger, 'settings.view-ai-evaluations-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiEvaluationRunListBody(result.value);
  }

  @Get('ai-models/evaluations/estimate')
  @ApiOperation({
    summary: 'The estimated cost of an AI evaluation run of a model (admin)',
    description:
      'Needs settings.ai-gateway.view. Per capability with an evaluation suite the model can ' +
      "serve in the Market, its sample count and the sum of each sample's reservation on the " +
      "model's routes; the evaluation budget left this month; and what blocks a run now. Calls " +
      'no model.',
  })
  @ApiQuery({ name: 'provider', required: true })
  @ApiQuery({ name: 'family', required: true })
  @ApiOkResponse({ type: AiEvaluationEstimateBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async aiEvaluationEstimate(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('provider') provider?: unknown,
    @Query('family') family?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.estimateEvaluation.execute(context, { provider, family });
    logRoute(this.#logger, 'settings.estimate-ai-evaluation-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiEvaluationEstimateBody(result.value);
  }

  @Get('ai-models/evaluations/:runId')
  @ApiOperation({
    summary: 'One AI evaluation run of the Market (admin)',
    description:
      "Needs settings.ai-gateway.view. Each capability's versions and verdict (a " +
      'pass-candidate is never a pass) and each sample: outcome, check codes, route, tokens, ' +
      'cost and latency. No model text is stored. A run of another Market is 404.',
  })
  @ApiParam({ name: 'runId', format: 'uuid' })
  @ApiOkResponse({ type: AiEvaluationRunDetailBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ai.evaluation-not-found' })
  async aiEvaluation(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('runId') runId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewEvaluation.execute(context, { runId });
    logRoute(this.#logger, 'settings.view-ai-evaluation-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiEvaluationRunDetailBody(result.value);
  }

  // Always a fresh two-step code: the guard asks first, and the use case spends the proof in the
  // unit that queues the run and writes its audit row.
  @Post('ai-models/evaluations')
  @HttpCode(202)
  @RequiresStepUp(SETTINGS_AI_EVALUATION_STEP_UP)
  @ApiOperation({
    summary: 'Start an AI evaluation run of a model (admin)',
    description:
      'Needs the protected settings.ai-models.manage and a fresh two-step proof of this admin ' +
      '(`POST identity/admin/step-up/verify` for settings.ai-evaluation.run; without it 403 ' +
      'second-factor.required with details.actionKey); refused in an acting-as session. ' +
      '`expectedEstimateMicroUsd` is the estimate the admin confirmed: a different one now is 400 ' +
      'validation.failed (expectedEstimateMicroUsd: stale), and anything that blocks the run is ' +
      '400 with family: <blocker>. Queued for the background job (one open run per model and ' +
      'Market), paid from the evaluation budget, audited. Its result is only a pass candidate.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RunAiEvaluationRequest })
  @ApiAcceptedResponse({ type: AiEvaluationQueuedBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async postAiEvaluation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'provider',
      'family',
      'expectedEstimateMicroUsd',
    ]);
    if (invalid !== null) throw invalid;
    const { provider, family, expectedEstimateMicroUsd } = requestBody as Record<string, unknown>;
    const result = await this.runEvaluation.execute(context, {
      provider,
      family,
      expectedEstimateMicroUsd,
    });
    logRoute(this.#logger, 'settings.run-ai-evaluation-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { runId: result.value.runId, estimate: aiEvaluationEstimateBody(result.value.estimate) };
  }

  // Stopping spends nothing: no two-step code (design section 8).
  @Post('ai-models/evaluations/:runId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel an AI evaluation run (admin)',
    description:
      'Needs the protected settings.ai-models.manage; refused in an acting-as session. A queued ' +
      'or running run of the Market stops before its next sample; any other run is 404.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'runId', format: 'uuid' })
  @ApiOkResponse({ type: AiEvaluationCancelledBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'ai.evaluation-not-found' })
  async cancelAiEvaluation(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('runId') runId: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.cancelEvaluation.execute(context, { runId });
    logRoute(this.#logger, 'settings.cancel-ai-evaluation-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return { runId: result.value.runId };
  }

  @Get('ai-models/playground/samples')
  @ApiOperation({
    summary: 'The samples the AI playground can run (admin)',
    description:
      'Needs settings.ai-gateway.view. Per capability with an evaluation suite, each synthetic ' +
      "sample's id and a plain-text summary of its input. No customer data.",
  })
  @ApiOkResponse({ type: AiPlaygroundSamplesBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiPlaygroundSamples(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewPlaygroundSamples.execute(context, {});
    logRoute(this.#logger, 'settings.view-ai-playground-samples-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiPlaygroundSamplesBody(result.value);
  }

  // No two-step code: ids only, a small daily limit, nothing stored or changed.
  @Post('ai-models/playground')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run one AI evaluation sample on two models side by side (admin)',
    description:
      'Needs the protected settings.ai-models.manage; refused in an acting-as session. The body ' +
      'holds ids only (capability, sampleId, two distinct families); any other field is 400. At ' +
      'most 20 runs per admin per Market day (429 ai.playground-limit-reached). Paid from the ' +
      "evaluation budget; each answer is the capability's guarded plain text (never HTML), with " +
      'its check codes, cost, latency and route kind. Nothing is stored.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RunAiPlaygroundRequest })
  @ApiOkResponse({ type: AiPlaygroundBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'ai.playground-limit-reached' })
  async postAiPlayground(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['capability', 'sampleId', 'families']);
    if (invalid !== null) throw invalid;
    const { capability, sampleId, families } = requestBody as Record<string, unknown>;
    const result = await this.runPlayground.execute(context, { capability, sampleId, families });
    logRoute(this.#logger, 'settings.run-ai-playground-route', context, outcomeOf(result));
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return aiPlaygroundBody(result.value);
  }

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

  @Get('ai-models/history')
  @ApiOperation({
    summary: 'The history of one AI models setting of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. The latest changes of one setting of the AI models (`code`), ' +
      'newest first, at most `limit` (1 to 50, default 50): each version with the value before ' +
      'and after, when, the admin (display name, or null) and the note, and which one is in ' +
      'force. Older changes stay in the audit log.',
  })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: SettingHistoryBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiModelsHistory(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('code') code?: unknown,
    @Query('limit') limit?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewAiModelsHistory.execute(context, { code, limit: limitOf(limit) });
    logRoute(
      this.#logger,
      'settings.view-ai-models-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingHistoryBody(result.value);
  }

  // Every revert spends a two-step code in the use case's own unit, after the server checks.
  @Post('ai-models/revert')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revert one AI models setting of the Market to an earlier version (admin)',
    description:
      'Needs the protected settings.ai-models.manage; refused in an acting-as session. Brings `code` back to ' +
      'the value of `version` (0: the default) from the version in force the admin saw ' +
      '(`expectedVersion`; a stale one is 409 settings.conflict). A forward change: a new ' +
      'version with its history and audit row and, where reviewed, a high-risk review request. ' +
      "The External models tab's server checks run again on the page as it would stand (400 " +
      'validation.failed, as for PUT ai-models). ' +
      'Every revert needs a fresh two-step proof of this admin (`POST ' +
      'identity/admin/step-up/verify` for settings.ai-settings.revert; without it 403 ' +
      'second-factor.required with details.actionKey). A version not in the history is 400 ' +
      'validation.failed on `version`. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RevertSettingRequest })
  @ApiOkResponse({ type: SettingChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async revertAiModelsSetting(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'code',
      'version',
      'expectedVersion',
      'note',
    ]);
    if (invalid !== null) throw invalid;
    const { code, version, expectedVersion, note } = requestBody as Record<string, unknown>;
    const result = await this.revertAiModels.execute(context, {
      code,
      version,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'settings.revert-ai-models-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingChangeBody(result.value);
  }

  @Get('ai-gateway')
  @ApiOperation({
    summary: 'The AI Gateway settings of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. ai-gateway-emergency-stop (off by default) and the caps ' +
      'ai-cap-market-day, ai-cap-market-month, ai-cap-capability-day, ai-cap-seller-day and ' +
      'ai-cap-guest-day (none by default, else whole US micro-dollars as decimal text; 0 allows ' +
      'nothing), ai-cap-evaluation-month (default 0, never none), and the buyer assistant ' +
      "chat's own ai-cap-buyer-chat-day and ai-cap-buyer-chat-month (defaults 10000000 and " +
      '200000000, or none), and the capability switches ai-capability-<capability> (on by ' +
      'default, or off), each with its version (0 while the default is in force).',
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
      'or whole US micro-dollars (0 to 1000000000000); ai-cap-buyer-chat-day may not be above ' +
      'ai-cap-buyer-chat-month when both are numbers (validation.failed, path ' +
      'ai-cap-buyer-chat-day). Raising or lifting any cap needs a fresh ' +
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

  @Put('ai-gateway/capabilities')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Switch single AI capabilities of the Market off or on (admin)',
    description:
      'Needs the protected settings.ai-gateway.manage; refused in an acting-as session. ' +
      '`changes` lists each changed switch once (ai-capability-assistant-buyer-chat, ' +
      'ai-capability-catalog-description-writer-seller, ' +
      'ai-capability-catalog-description-writer-admin; `off` or `on`, `on` by default) with the ' +
      'version the admin saw; the switches are read with GET ai-gateway. Off: the capability is ' +
      'off from the next call, with no two-step code. On: needs a fresh two-step proof of this ' +
      'admin (`POST identity/admin/step-up/verify` for settings.ai-capability.resume; without it ' +
      '403 second-factor.required with details.actionKey). The module switches and the seller ' +
      'switch still apply. All or nothing: a stale version is 409 settings.conflict. Each change ' +
      'is audited and, where reviewed, opens a high-risk review request; a rejected review never ' +
      'switches a capability on. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeOfferReviewRequest })
  @ApiOkResponse({ type: SettingsChangeListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async putAiCapabilities(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['changes', 'note']);
    if (invalid !== null) throw invalid;
    const { changes, note } = requestBody as { changes?: unknown; note?: unknown };
    const result = await this.changeAiCapabilities.execute(context, { changes, note });
    logRoute(
      this.#logger,
      'settings.change-ai-capabilities-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingsChangeListBody(result.value);
  }

  @Get('ai-gateway/history')
  @ApiOperation({
    summary: 'The history of one AI Gateway setting of the Market (admin)',
    description:
      'Needs settings.ai-gateway.view. The latest changes of one setting of the AI Gateway (`code`), ' +
      'newest first, at most `limit` (1 to 50, default 50): each version with the value before ' +
      'and after, when, the admin (display name, or null) and the note, and which one is in ' +
      'force. Older changes stay in the audit log.',
  })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: SettingHistoryBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async aiGatewayHistory(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('code') code?: unknown,
    @Query('limit') limit?: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewAiGatewayHistory.execute(context, {
      code,
      limit: limitOf(limit),
    });
    logRoute(
      this.#logger,
      'settings.view-ai-gateway-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingHistoryBody(result.value);
  }

  // Every revert spends a two-step code in the use case's own unit, after the server checks.
  @Post('ai-gateway/revert')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revert one AI Gateway setting of the Market to an earlier version (admin)',
    description:
      'Needs the protected settings.ai-gateway.manage; refused in an acting-as session. Brings `code` back to ' +
      'the value of `version` (0: the default) from the version in force the admin saw ' +
      '(`expectedVersion`; a stale one is 409 settings.conflict). A forward change: a new ' +
      'version with its history and audit row and, where reviewed, a high-risk review request. ' +
      'ai-cap-buyer-chat-day is still never above ai-cap-buyer-chat-month; a revert of ' +
      'ai-gateway-emergency-stop always needs a note. ' +
      'Every revert needs a fresh two-step proof of this admin (`POST ' +
      'identity/admin/step-up/verify` for settings.ai-settings.revert; without it 403 ' +
      'second-factor.required with details.actionKey). A version not in the history is 400 ' +
      'validation.failed on `version`. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RevertSettingRequest })
  @ApiOkResponse({ type: SettingChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
  @ApiConflictResponse({ ...ERROR, description: 'settings.conflict' })
  async revertAiGatewaySetting(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, [
      'code',
      'version',
      'expectedVersion',
      'note',
    ]);
    if (invalid !== null) throw invalid;
    const { code, version, expectedVersion, note } = requestBody as Record<string, unknown>;
    const result = await this.revertAiGateway.execute(context, {
      code,
      version,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'settings.revert-ai-gateway-setting-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return settingChangeBody(result.value);
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
      'Needs settings.ai.view. ai-description-writer (off by default) with its version (0 while ' +
      "the default is in force). The writer's models are the Market's list for the write task " +
      'type (settings/admin/ai-models); the provider routes and keys are server configuration.',
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
      'Switching the writer on needs a fresh two-step proof of this admin (`POST ' +
      'identity/admin/step-up/verify` for settings.ai-capability.resume; without it 403 ' +
      'second-factor.required with details.actionKey); switching it off needs none. ' +
      REVIEWED,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeAiSettingRequest })
  @ApiOkResponse({ type: SettingChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: STEP_UP_FORBIDDEN })
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
