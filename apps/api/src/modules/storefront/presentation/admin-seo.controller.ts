import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
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
import { changeHistoryBody, changeHistoryInputOf } from '../../../platform/audit/change-trail';
import { ChangeHistoryDto } from '../../../platform/audit/change-trail.dto';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RestoreStorefrontSeoSettings } from '../application/use-cases/restore-seo-settings.use-case';
import { SetStorefrontProtectedSeoSettings } from '../application/use-cases/set-protected-seo-settings.use-case';
import { SetStorefrontSeoSettings } from '../application/use-cases/set-seo-settings.use-case';
import { ViewStorefrontSeoSettings } from '../application/use-cases/view-seo-settings.use-case';
import { ViewStorefrontSeoSettingsHistory } from '../application/use-cases/view-seo-settings-history.use-case';
import { STOREFRONT_SEO_PROTECTED_STEP_UP } from '../contracts/step-up';
import { closedBody, refusal } from './http-answers';
import {
  RestoreSeoSettingsRequest,
  SeoSettingsBody,
  seoSettingsBody,
  SetSeoSettingsRequest,
} from './seo.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The Market's SEO settings, read and changed by an admin. Thin adapters: each use case does its work
 * behind its gate. Every answer is `Cache-Control: no-store`; the body is never logged.
 */
@ApiTags('storefront')
@RoutePopulation('admin')
@ReadsSession()
@Controller('storefront/admin/seo')
export class AdminSeoController {
  readonly #logger = new Logger('AdminSeoController');

  constructor(
    private readonly view: ViewStorefrontSeoSettings,
    private readonly history: ViewStorefrontSeoSettingsHistory,
    private readonly set: SetStorefrontSeoSettings,
    private readonly setProtected: SetStorefrontProtectedSeoSettings,
    private readonly restore: RestoreStorefrontSeoSettings,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The SEO settings of the Market (admin)',
    description:
      'Needs storefront.seo.view. Version 0 is the code defaults (indexing off). sampleDataLock says ' +
      'indexing cannot be turned on yet; envCeiling off keeps every page out of the index whatever ' +
      'the switch says. lastChanged says who changed the settings last and when.',
  })
  @ApiOkResponse({ type: SeoSettingsBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log('storefront.view-seo-settings-route', context, result.ok ? 'read' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return seoSettingsBody(result.value);
  }

  @Get('history')
  @ApiOperation({
    summary: 'The versions of the SEO settings (admin)',
    description:
      'Needs storefront.seo.view. Newest first: the version, when, who (a display name, never an ' +
      'email) and the names of the fields that changed, never their values. Paged with after (the ' +
      'next of the previous page) and limit (1 to 50, default 20).',
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
      'storefront.view-seo-settings-history-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return changeHistoryBody(result.value);
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change the texts and templates of the SEO settings (admin)',
    description:
      'Needs storefront.seo.edit. The settings object holds exactly siteName, titleTemplate, ' +
      'defaultDescription, defaultShareImage, sellerPages, sameAs and pageTemplates; the other fields ' +
      'stay as they are. expectedVersion is the version the screen read; a different current version ' +
      'answers storefront.conflict. The same settings again change nothing. A change is live at once ' +
      'and is a new version in an insert-only history, with an audit row.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSeoSettingsRequest })
  @ApiOkResponse({ type: SeoSettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'storefront.conflict (another admin saved first; details.lastChanged says who and when)',
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
    const result = await this.set.execute(context, { settings, expectedVersion });
    this.log('storefront.set-seo-settings-route', context, result.ok ? 'set' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return seoSettingsBody(result.value);
  }

  @Put('protected')
  @HttpCode(200)
  @RequiresStepUp(STOREFRONT_SEO_PROTECTED_STEP_UP)
  @ApiOperation({
    summary: 'Change the indexing switch, business details and tool codes (admin)',
    description:
      'Needs storefront.seo.manage (protected) and a fresh two-step proof of this admin session for ' +
      '`storefront.seo.change-protected` (`POST /identity/admin/step-up/verify`, valid 5 minutes); ' +
      'without one the answer is 403 second-factor.required with details.actionKey. Refused in an ' +
      'acting-as session. The settings object holds exactly indexing, logo, tradingName, legalName, ' +
      'abn, postalAddress, contactEmail, contactPhone, googleVerification, bingVerification and ' +
      'analyticsId; the other fields stay as they are. Turning indexing on is refused while ' +
      'sampleDataLock is true (validation.failed, code locked). A stale expectedVersion keeps the proof.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSeoSettingsRequest })
  @ApiOkResponse({ type: SeoSettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required (details.actionKey) or ' +
      'second-factor.enrolment-required',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  @ApiConflictResponse({ ...ERROR, description: 'storefront.conflict (details.lastChanged)' })
  async putProtected(
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
    const result = await this.setProtected.execute(context, { settings, expectedVersion });
    this.log(
      'storefront.set-protected-seo-settings-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return seoSettingsBody(result.value);
  }

  @Post('restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bring an older version of the SEO settings back (admin)',
    description:
      'Needs storefront.seo.edit; when the version changes a protected field it also needs ' +
      'storefront.seo.manage and a fresh two-step proof for `storefront.seo.change-protected`, and ' +
      'is refused in an acting-as session. Makes a new version with the old values (history is never ' +
      'rewritten). Version 0 brings back the code defaults. The same values as now change nothing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RestoreSeoSettingsRequest })
  @ApiOkResponse({ type: SeoSettingsBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required or second-factor.enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.seo-version-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  @ApiConflictResponse({ ...ERROR, description: 'storefront.conflict (details.lastChanged)' })
  async restoreVersion(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion', 'version']);
    if (invalid !== null) throw invalid;
    const { version, expectedVersion } = requestBody as {
      version?: unknown;
      expectedVersion?: unknown;
    };
    const result = await this.restore.execute(context, { version, expectedVersion });
    this.log(
      'storefront.restore-seo-settings-route',
      context,
      result.ok ? 'restored' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return seoSettingsBody(result.value);
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
