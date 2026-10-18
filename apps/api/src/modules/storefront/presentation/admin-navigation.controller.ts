import { Body, Controller, Get, HttpCode, Logger, Post, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import type { PageDetailView } from '../application/use-cases/view-page.use-case';
import { ApproveStorefrontNavigation } from '../application/use-cases/approve-navigation.use-case';
import { ReplaceStorefrontNavigationDraft } from '../application/use-cases/replace-navigation-draft.use-case';
import { RestoreStorefrontNavigationVersion } from '../application/use-cases/restore-navigation-version.use-case';
import { ViewStorefrontNavigation } from '../application/use-cases/view-navigation.use-case';
import { closedBody, refusal } from './http-answers';
import {
  NavigationDraftRequest,
  PageDetailBody,
  PublishRequest,
  RestoreRequest,
  detailBody,
} from './storefront.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = { ...ERROR, description: 'access.denied or request.csrf' };

/**
 * The buyer site's navigation, for admins (john 17 Oct): the left-rail items and the Browse
 * drawer's category lists. A content editor replaces the draft; buyers see it only after a
 * platform admin approves it (`storefront.navigation.approve`, protected, separate from
 * publishing pages). Every answer is `Cache-Control: no-store`.
 */
@ApiTags('storefront')
@RoutePopulation('admin')
@ReadsSession()
@Controller('storefront/admin/navigation')
export class AdminNavigationController {
  readonly #logger = new Logger('AdminNavigationController');

  constructor(
    private readonly view: ViewStorefrontNavigation,
    private readonly replace: ReplaceStorefrontNavigationDraft,
    private readonly restore: RestoreStorefrontNavigationVersion,
    private readonly approve: ApproveStorefrontNavigation,
  ) {}

  private answer(
    msg: string,
    context: CallContext,
    result: Result<PageDetailView, { readonly code: string } & Record<string, unknown>>,
  ) {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return detailBody(result.value);
  }

  @Get()
  @ApiOperation({
    summary: 'The navigation: draft, approved version and versions (admin)',
    description: 'Needs storefront.page.read.',
  })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.answer(
      'storefront.view-navigation-route',
      context,
      await this.view.execute(context, {}),
    );
  }

  @Put('draft')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Replace the navigation draft (content editor)',
    description:
      'Needs storefront.navigation.edit. The left-rail items (nav-link) and the Browse drawer ' +
      'categories (nav-category), in order. Buyers see nothing until it is approved. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: NavigationDraftRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  async putDraft(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['slots']);
    if (invalid !== null) throw invalid;
    return this.answer(
      'storefront.replace-navigation-draft-route',
      context,
      await this.replace.execute(context, body),
    );
  }

  @Post('restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Copy an earlier navigation version into the draft (content editor)',
    description: 'Needs storefront.navigation.edit. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RestoreRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.version-not-found' })
  async restoreVersion(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['versionId']);
    if (invalid !== null) throw invalid;
    const versionId = (body as { versionId?: unknown }).versionId;
    return this.answer(
      'storefront.restore-navigation-version-route',
      context,
      await this.restore.execute(context, { versionId }),
    );
  }

  @Post('approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve the navigation draft (platform admin)',
    description:
      'Needs storefront.navigation.approve (protected). Buyers see the approved navigation from now ' +
      'on; the one they saw is kept. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PublishRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({
    ...ERROR,
    description: 'storefront.nothing-to-publish or storefront.draft-changed',
  })
  async approveDraft(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['versionNo', 'updatedAt']);
    if (invalid !== null) throw invalid;
    return this.answer(
      'storefront.approve-navigation-route',
      context,
      await this.approve.execute(context, { body }),
    );
  }
}
