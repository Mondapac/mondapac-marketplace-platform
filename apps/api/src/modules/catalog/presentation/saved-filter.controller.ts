import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { SavedFilterCreate } from '../application/use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from '../application/use-cases/saved-filter-delete.use-case';
import { SavedFilterUpdate } from '../application/use-cases/saved-filter-update.use-case';
import {
  SAVED_FILTER_LIST_KEYS,
  SavedFiltersList,
} from '../application/use-cases/saved-filters-list.use-case';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  SavedFilterCreateRequest,
  SavedFilterDeletedDto,
  SavedFilterDto,
  SavedFilterListDto,
  SavedFilterUpdateRequest,
} from './saved-filter.dto';

/**
 * The HTTP status of each refusal of the saved-filter routes (catalog design 9.2d). A malformed
 * request is 400; a filter that is unknown or that somebody else keeps for themselves is 404
 * (the same answer); a name already used and the two caps are 409; a missing dependency is 503.
 * `access.denied` (including "everyone" without the share key) is 403 from the platform table.
 */
export const SAVED_FILTER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'saved-filter.not-found': 404,
  'saved-filter.name-taken': 409,
  'saved-filter.limit-reached': 409,
  'saved-filter.shared-limit-reached': 409,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const ID_PARAM = { name: 'id', description: 'The saved filter id (a UUID v7).' };

/**
 * The saved filters of the admin lists over HTTP (catalog design 9.2d): list, create, rename and
 * set who can use one, delete. Admin routes read the admin session, so a write needs the CSRF
 * token and the panel's origin. A thin adapter: one use case each does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/saved-filters')
export class SavedFilterController {
  constructor(
    private readonly list: SavedFiltersList,
    private readonly create: SavedFilterCreate,
    private readonly update: SavedFilterUpdate,
    private readonly remove: SavedFilterDelete,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the saved filters of an admin list',
    description:
      'Needs catalog.product.view. The caller’s own filters first, then the ones shared with ' +
      'everyone by other admins, each group oldest first. Each has its document, `ownedByMe`, ' +
      '`canManage` and, for the first 12, the `count` of products it matches now. `canShare` ' +
      'says whether the caller holds catalog.saved-filter.share.',
  })
  @ApiQuery({ name: 'listKey', required: true, enum: SAVED_FILTER_LIST_KEYS })
  @ApiOkResponse({ type: SavedFilterListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async listFilters(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<SavedFilterListDto> {
    const result = await this.list.execute(context, { ...query });
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterListDto;
  }

  @Post()
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the tab, search, filters and sort of a list under a name',
    description:
      'Needs catalog.product.view. `visibility` is me or everyone; everyone also needs ' +
      'catalog.saved-filter.share (else access.denied). `payload` is a closed document: v 1, ' +
      'view, optional q, optional filters (scope, status, categoryId, typeCode, sellerId), ' +
      'sort and direction; an unknown key is refused. At most 50 filters per admin and list ' +
      '(saved-filter.limit-reached) and 20 shared with everyone per list ' +
      '(saved-filter.shared-limit-reached, details.max). A name is one per owner and, among ' +
      'shared filters, one per list, whatever its case (saved-filter.name-taken). A filter ' +
      'shared with everyone is audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterCreateRequest })
  @ApiCreatedResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'saved-filter.name-taken, saved-filter.limit-reached or saved-filter.shared-limit-reached ' +
      '(details.max)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async createFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SavedFilterDto> {
    const input = closedBody(request, body, ['listKey', 'name', 'visibility', 'payload']);
    if (input instanceof HttpException) throw input;
    const result = await this.create.execute(context, input);
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterDto;
  }

  @Put(':id')
  @ReadsSession()
  @ApiOperation({
    summary: 'Rename a saved filter and set who can use it',
    description:
      'Needs catalog.product.view. Sets `name` and `visibility` (both); the document of a filter ' +
      'never changes. The owner may always; any admin with catalog.saved-filter.share may also ' +
      'change a filter shared with everyone. Making a filter everyone needs the share key for ' +
      'everybody. Another admin’s private filter is saved-filter.not-found. Changes to or from ' +
      'everyone are audited.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterUpdateRequest })
  @ApiOkResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'saved-filter.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'saved-filter.name-taken or saved-filter.shared-limit-reached (details.max)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async updateFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SavedFilterDto> {
    const input = closedBody(request, body, ['name', 'visibility']);
    if (input instanceof HttpException) throw input;
    const result = await this.update.execute(context, { ...input, id });
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterDto;
  }

  @Delete(':id')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete a saved filter',
    description:
      'Needs catalog.product.view. The owner may always; any admin with ' +
      'catalog.saved-filter.share may also delete a filter shared with everyone. Another admin’s ' +
      'private filter is saved-filter.not-found. Deleting a shared filter is audited.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SavedFilterDeletedDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'saved-filter.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async deleteFilter(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<SavedFilterDeletedDto> {
    const result = await this.remove.execute(context, { id });
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return result.value;
  }
}
