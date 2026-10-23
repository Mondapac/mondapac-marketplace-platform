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
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ArchiveStorefrontSlide } from '../application/use-cases/archive-slide.use-case';
import { CreateStorefrontSlide } from '../application/use-cases/create-slide.use-case';
import { ListStorefrontSlides } from '../application/use-cases/list-slides.use-case';
import { PrepareStorefrontSlideCopy } from '../application/use-cases/prepare-slide-copy.use-case';
import { RestoreStorefrontSlideVersion } from '../application/use-cases/restore-slide-version.use-case';
import { UpdateStorefrontSlideDraft } from '../application/use-cases/update-slide-draft.use-case';
import { ViewStorefrontSlide } from '../application/use-cases/view-slide.use-case';
import { closedBody, refusal } from './http-answers';
import {
  SlideCopyBody,
  SlideDetailBody,
  SlideListBody,
  SlideRequest,
  SlideVersionRequest,
  slideCopyBody,
  slideDetailBody,
  slideSummaryBody,
} from './slide.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const SLIDE = { name: 'slide', description: 'A slide id.' };
const DRAFT_FIELDS = [
  'internalName',
  'content',
  'startsAt',
  'endsAt',
  'pinned',
  'sponsored',
  'placements',
];
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = { ...ERROR, description: 'access.denied or request.csrf' };
const NOT_FOUND = {
  ...ERROR,
  description: 'storefront.slide-not-found or storefront.slide-version-not-found',
};
const CONFLICT = {
  ...ERROR,
  description: 'storefront.slide-archived or storefront.slide-version-limit',
};

/**
 * The slide library, for admins (john 23 Oct): list, create, change the draft, restore a version,
 * copy out for another Market and archive. Approving, pausing and resuming are routes of the same
 * controller. Thin adapters: each use case does its work behind its gate. Unsafe requests carry a
 * session cookie, so the Origin and Sec-Fetch-Site checks and the CSRF token apply as on every
 * admin route. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('storefront')
@RoutePopulation('admin')
@ReadsSession()
@Controller('storefront/admin/slides')
export class AdminSlideController {
  readonly #logger = new Logger('AdminSlideController');

  constructor(
    private readonly list: ListStorefrontSlides,
    private readonly create: CreateStorefrontSlide,
    private readonly view: ViewStorefrontSlide,
    private readonly update: UpdateStorefrontSlideDraft,
    private readonly copy: PrepareStorefrontSlideCopy,
    private readonly restore: RestoreStorefrontSlideVersion,
    private readonly archive: ArchiveStorefrontSlide,
  ) {}

  private answer<T, U>(
    msg: string,
    context: CallContext,
    result: Result<T, { readonly code: string } & Record<string, unknown>>,
    body: (value: T) => U,
  ): U {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return body(result.value);
  }

  @Get()
  @ApiOperation({
    summary: 'The slides of the Market (admin)',
    description: 'Needs storefront.slide.read. Optionally only one status and/or one position.',
  })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'position', required: false })
  @ApiOkResponse({ type: SlideListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(
    @Call() context: CallContext,
    @Query('state') state: string | undefined,
    @Query('position') position: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { state, position });
    return this.answer('storefront.list-slides-route', context, result, (slides) => ({
      slides: slides.map(slideSummaryBody),
    }));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a slide, as a draft (admin)',
    description:
      'Needs storefront.slide.edit. Plain text only, no URL: a link is a typed reference. Buyers ' +
      'see nothing until a platform admin approves it. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SlideRequest })
  @ApiCreatedResponse({ type: SlideDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['kind', ...DRAFT_FIELDS]);
    if (invalid !== null) throw invalid;
    const result = await this.create.execute(context, body);
    return this.answer('storefront.create-slide-route', context, result, slideDetailBody);
  }

  @Get(':slide')
  @ApiOperation({
    summary: 'A slide: draft, live version and versions (admin)',
    description: 'Needs storefront.slide.read.',
  })
  @ApiParam(SLIDE)
  @ApiOkResponse({ type: SlideDetailBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  async one(
    @Call() context: CallContext,
    @Param('slide') slide: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { slide });
    return this.answer('storefront.view-slide-route', context, result, slideDetailBody);
  }

  @Put(':slide')
  @HttpCode(200)
  @ApiOperation({
    summary: "Replace a slide's draft (admin)",
    description:
      'Needs storefront.slide.edit. The whole body again; saved as a new version, and a ' +
      'submission for approval is withdrawn. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(SLIDE)
  @ApiBody({ type: SlideRequest })
  @ApiOkResponse({ type: SlideDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async put(
    @Call() context: CallContext,
    @Param('slide') slide: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, DRAFT_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.update.execute(context, { slide, body });
    return this.answer('storefront.update-slide-draft-route', context, result, slideDetailBody);
  }

  @Get(':slide/copy')
  @ApiOperation({
    summary: 'A slide as a package to create in another Market (admin)',
    description:
      'Needs storefront.slide.read. There is no cross-Market admin: an editor of the other Market ' +
      "posts this body to that Market's POST storefront/admin/slides (storefront.slide.edit " +
      'there). Scopes are reset to "all"; links must be checked in the other Market.',
  })
  @ApiParam(SLIDE)
  @ApiOkResponse({ type: SlideCopyBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  async copyOut(
    @Call() context: CallContext,
    @Param('slide') slide: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.copy.execute(context, { slide });
    return this.answer('storefront.prepare-slide-copy-route', context, result, slideCopyBody);
  }

  @Post(':slide/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Copy an earlier version into the draft (admin)',
    description: 'Needs storefront.slide.edit. A new version; the earlier one is kept. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(SLIDE)
  @ApiBody({ type: SlideVersionRequest })
  @ApiOkResponse({ type: SlideDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async restoreVersion(
    @Call() context: CallContext,
    @Param('slide') slide: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['versionId']);
    if (invalid !== null) throw invalid;
    const versionId = (body as { versionId?: unknown }).versionId;
    const result = await this.restore.execute(context, { slide, versionId });
    return this.answer('storefront.restore-slide-version-route', context, result, slideDetailBody);
  }

  @Post(':slide/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a slide (admin)',
    description: 'Needs storefront.slide.edit. It is never served again. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(SLIDE)
  @ApiOkResponse({ type: SlideDetailBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async archiveSlide(
    @Call() context: CallContext,
    @Param('slide') slide: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.archive.execute(context, { slide });
    return this.answer('storefront.archive-slide-route', context, result, slideDetailBody);
  }
}
