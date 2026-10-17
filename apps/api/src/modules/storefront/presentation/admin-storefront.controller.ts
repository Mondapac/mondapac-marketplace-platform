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
import { AddStorefrontModule } from '../application/use-cases/add-module.use-case';
import { ArchiveStorefrontPage } from '../application/use-cases/archive-page.use-case';
import { CreateStorefrontPage } from '../application/use-cases/create-page.use-case';
import { ListStorefrontPages } from '../application/use-cases/list-pages.use-case';
import { PublishStorefrontPage } from '../application/use-cases/publish-page.use-case';
import { RemoveStorefrontModule } from '../application/use-cases/remove-module.use-case';
import { ReorderStorefrontModules } from '../application/use-cases/reorder-modules.use-case';
import { RestoreStorefrontPageVersion } from '../application/use-cases/restore-page-version.use-case';
import { UpdateStorefrontModule } from '../application/use-cases/update-module.use-case';
import { UpdateStorefrontPageSettings } from '../application/use-cases/update-page-settings.use-case';
import { ViewStorefrontCatalogue } from '../application/use-cases/view-catalogue.use-case';
import { ViewStorefrontPage } from '../application/use-cases/view-page.use-case';
import { closedBody, refusal } from './http-answers';
import {
  AddModuleRequest,
  ArchiveRequest,
  PublishRequest,
  CatalogueBody,
  NewPageRequest,
  PageDetailBody,
  PageListBody,
  ReorderRequest,
  RestoreRequest,
  UpdateModuleRequest,
  catalogueBody,
  detailBody,
  summaryBody,
} from './storefront.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const PAGE = {
  name: 'page',
  description: 'A page id, or the key of a system page (home, offers, cart, ...).',
};
const PAGE_FIELDS = ['templateKey', 'title', 'slug', 'seo', 'linked', 'startsAt', 'endsAt'];
const SETTINGS_FIELDS = ['title', 'slug', 'seo', 'linked', 'startsAt', 'endsAt'];
const UNAUTHORIZED = { ...ERROR, description: 'access.unauthenticated or session.invalid' };
const FORBIDDEN = { ...ERROR, description: 'access.denied or request.csrf' };
const NOT_FOUND = {
  ...ERROR,
  description:
    'storefront.page-not-found, storefront.slot-not-found or storefront.placement-not-found',
};
const CONFLICT = {
  ...ERROR,
  description: 'storefront.page-locked, storefront.page-archived or storefront.slot-full',
};

/**
 * The storefront pages, for admins (content-management analysis 2 to 7): the page list, a page's
 * settings, its draft (modules added, changed, switched on or off, removed and reordered inside
 * its template's slots), restoring a version, publishing and archiving. Thin adapters: each use
 * case does its work behind its gate. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('storefront')
@RoutePopulation('admin')
@ReadsSession()
@Controller('storefront/admin')
export class AdminStorefrontController {
  readonly #logger = new Logger('AdminStorefrontController');

  constructor(
    private readonly catalogue: ViewStorefrontCatalogue,
    private readonly list: ListStorefrontPages,
    private readonly view: ViewStorefrontPage,
    private readonly create: CreateStorefrontPage,
    private readonly settings: UpdateStorefrontPageSettings,
    private readonly add: AddStorefrontModule,
    private readonly update: UpdateStorefrontModule,
    private readonly remove: RemoveStorefrontModule,
    private readonly reorder: ReorderStorefrontModules,
    private readonly restore: RestoreStorefrontPageVersion,
    private readonly publish: PublishStorefrontPage,
    private readonly archive: ArchiveStorefrontPage,
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

  @Get('catalogue')
  @ApiOperation({
    summary: 'The page templates, their slots and the module catalogue (admin)',
    description: 'Needs storefront.page.read. Code only: templates and modules are not editable.',
  })
  @ApiOkResponse({ type: CatalogueBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async templates(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.catalogue.execute(context, {});
    return this.answer('storefront.view-catalogue-route', context, result, catalogueBody);
  }

  @Get('pages')
  @ApiOperation({
    summary: 'Every storefront page of the Market (admin)',
    description:
      'Needs storefront.page.read. Every system page (changed or not), then the dynamic pages.',
  })
  @ApiOkResponse({ type: PageListBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {});
    return this.answer('storefront.list-pages-route', context, result, (pages) => ({
      pages: pages.map(summaryBody),
    }));
  }

  @Post('pages')
  @ApiOperation({
    summary: 'Create a landing page from a template (admin)',
    description:
      "Needs storefront.page.create. The draft starts with the template's default modules; buyers " +
      'see nothing until it is published. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: NewPageRequest })
  @ApiCreatedResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({ ...ERROR, description: 'storefront.slug-taken' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, PAGE_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.create.execute(context, body);
    return this.answer('storefront.create-page-route', context, result, detailBody);
  }

  @Get('pages/:page')
  @ApiOperation({
    summary: 'A storefront page: settings, slots, draft, published version, versions (admin)',
    description: 'Needs storefront.page.read.',
  })
  @ApiParam(PAGE)
  @ApiOkResponse({ type: PageDetailBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  async one(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { page });
    return this.answer('storefront.view-page-route', context, result, detailBody);
  }

  @Put('pages/:page')
  @HttpCode(200)
  @ApiOperation({
    summary: "Change a page's settings (admin)",
    description:
      'Needs storefront.page.edit. A landing page: title, slug (an old slug keeps sending buyers ' +
      'on), SEO, linked entity, live window, all replaced. A system page: title and SEO only. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'storefront.slug-taken, storefront.page-locked or storefront.page-archived',
  })
  async put(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, SETTINGS_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.settings.execute(context, { page, body });
    return this.answer('storefront.update-page-settings-route', context, result, detailBody);
  }

  @Post('pages/:page/slots/:slot/modules')
  @ApiOperation({
    summary: "Add a module to a slot of a page's draft (admin)",
    description:
      'Needs storefront.page.edit. Only a module the slot allows, within its maximum. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiParam({ name: 'slot' })
  @ApiBody({ type: AddModuleRequest })
  @ApiCreatedResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async addModule(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Param('slot') slot: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['module', 'config', 'position', 'enabled']);
    if (invalid !== null) throw invalid;
    const result = await this.add.execute(context, { page, slot, body: body as AddModuleRequest });
    return this.answer('storefront.add-module-route', context, result, detailBody);
  }

  @Put('pages/:page/slots/:slot/modules/:placementId')
  @HttpCode(200)
  @ApiOperation({
    summary: "Change a module of a page's draft, or switch it on or off (admin)",
    description:
      'Needs storefront.page.edit. `config` replaces the settings; `enabled` switches it. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiParam({ name: 'slot' })
  @ApiParam({ name: 'placementId' })
  @ApiBody({ type: UpdateModuleRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async updateModule(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Param('slot') slot: string,
    @Param('placementId') placementId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['config', 'enabled']);
    if (invalid !== null) throw invalid;
    const result = await this.update.execute(context, {
      page,
      slot,
      placementId,
      body: body as UpdateModuleRequest,
    });
    return this.answer('storefront.update-module-route', context, result, detailBody);
  }

  @Delete('pages/:page/slots/:slot/modules/:placementId')
  @HttpCode(200)
  @ApiOperation({
    summary: "Remove a module from a page's draft (admin)",
    description: 'Needs storefront.page.edit. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiParam({ name: 'slot' })
  @ApiParam({ name: 'placementId' })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async removeModule(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Param('slot') slot: string,
    @Param('placementId') placementId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, { page, slot, placementId });
    return this.answer('storefront.remove-module-route', context, result, detailBody);
  }

  @Put('pages/:page/slots/:slot/order')
  @HttpCode(200)
  @ApiOperation({
    summary: "Reorder the modules of a slot of a page's draft (admin)",
    description:
      'Needs storefront.page.edit. `placementIds` names every module of the slot once. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiParam({ name: 'slot' })
  @ApiBody({ type: ReorderRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(CONFLICT)
  async order(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Param('slot') slot: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['placementIds']);
    if (invalid !== null) throw invalid;
    const placementIds = (body as { placementIds?: unknown }).placementIds;
    const result = await this.reorder.execute(context, { page, slot, placementIds });
    return this.answer('storefront.reorder-modules-route', context, result, detailBody);
  }

  @Post('pages/:page/restore')
  @HttpCode(200)
  @ApiOperation({
    summary: "Copy an earlier version into a page's draft (admin)",
    description: 'Needs storefront.page.edit. Buyers see it only after it is published. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiBody({ type: RestoreRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'storefront.page-not-found or storefront.version-not-found',
  })
  @ApiConflictResponse({
    ...ERROR,
    description: 'storefront.page-locked or storefront.page-archived',
  })
  async restoreVersion(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['versionId']);
    if (invalid !== null) throw invalid;
    const versionId = (body as { versionId?: unknown }).versionId;
    const result = await this.restore.execute(context, { page, versionId });
    return this.answer('storefront.restore-page-version-route', context, result, detailBody);
  }

  @Post('pages/:page/publish')
  @HttpCode(200)
  @ApiOperation({
    summary: "Publish a page's draft (platform admin)",
    description:
      'Needs storefront.page.publish (protected). Every slot must hold its minimum of switched-on ' +
      'modules. The version buyers saw is kept. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiBody({ type: PublishRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({
    ...ERROR,
    description: 'validation.failed (details.fields: too-few-modules, ...)',
  })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'storefront.nothing-to-publish, storefront.draft-changed, storefront.slug-taken, ' +
      'storefront.page-locked or storefront.page-archived',
  })
  async publishDraft(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['versionNo', 'updatedAt']);
    if (invalid !== null) throw invalid;
    const result = await this.publish.execute(context, { page, body });
    return this.answer('storefront.publish-page-route', context, result, detailBody);
  }

  @Post('pages/:page/archive')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Archive a landing page (platform admin)',
    description:
      'Needs storefront.page.archive (protected). Buyers no longer see it; its URL sends them to ' +
      '`redirectTo`, or is gone. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(PAGE)
  @ApiBody({ type: ArchiveRequest })
  @ApiOkResponse({ type: PageDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse(UNAUTHORIZED)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ ...ERROR, description: 'storefront.page-not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'storefront.page-locked or storefront.page-archived',
  })
  async archivePage(
    @Call() context: CallContext,
    @Param('page') page: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, body, ['redirectTo']);
    if (invalid !== null) throw invalid;
    const result = await this.archive.execute(context, { page, body });
    return this.answer('storefront.archive-page-route', context, result, detailBody);
  }
}
