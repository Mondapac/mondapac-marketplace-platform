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
import { SellerSavedFilterCreate } from '../application/use-cases/seller-saved-filter-create.use-case';
import { SellerSavedFilterDelete } from '../application/use-cases/seller-saved-filter-delete.use-case';
import { SellerSavedFilterUpdate } from '../application/use-cases/seller-saved-filter-update.use-case';
import { SellerSavedFiltersList } from '../application/use-cases/seller-saved-filters-list.use-case';
import { SellerSavedFiltersReorder } from '../application/use-cases/seller-saved-filters-reorder.use-case';
import { closedBody, refusalWith } from './http-answers';
import { SAVED_FILTER_STATUS } from './saved-filter.controller';
import {
  SavedFilterCreateRequest,
  SavedFilterDeletedDto,
  SavedFilterDto,
  SavedFilterListDto,
  SavedFiltersReorderedDto,
  SavedFiltersReorderRequest,
  SavedFilterUpdateRequest,
} from './saved-filter.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const ID_PARAM = { name: 'id', description: 'The saved filter id (a UUID v7).' };

/**
 * The saved filters of the seller lists over HTTP (super list B0-1b): list, create, rename and set
 * who can use one, delete, reorder. One set of routes for every admin list; the list is named by
 * `listKey` and its owner's view and share permissions are checked per call. A write needs the
 * CSRF token and the panel's origin. A thin adapter: one use case each does the work.
 */
@ApiTags('lists')
@RoutePopulation('seller')
@Controller('lists/seller/saved-filters')
export class ListsSellerSavedFilterController {
  constructor(
    private readonly list: SellerSavedFiltersList,
    private readonly create: SellerSavedFilterCreate,
    private readonly update: SellerSavedFilterUpdate,
    private readonly remove: SellerSavedFilterDelete,
    private readonly reorder: SellerSavedFiltersReorder,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the saved filters of a seller list',
    description:
      'Needs the list’s view permission. The caller’s own filters first, then the ones shared ' +
      'with everyone by other members of the store. `canShare` says whether the caller holds the list’s ' +
      'share permission. A filter whose document the list no longer reads is left out.',
  })
  @ApiQuery({ name: 'listKey', required: true })
  @ApiOkResponse({ type: SavedFilterListDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
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
      'Needs the list’s view permission; `everyone` also needs its share permission. `payload` ' +
      'is the closed document of that list. At most 50 filters per member and list and 20 shared ' +
      'with everyone; a name is one per owner and, among shared filters, one per list. A filter ' +
      'shared with everyone is audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterCreateRequest })
  @ApiCreatedResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    description:
      'saved-filter.name-taken, saved-filter.limit-reached or saved-filter.shared-limit-reached',
  })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
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

  // Declared before `:id`, so `order` is never read as an id.
  @Put('order')
  @ReadsSession()
  @ApiOperation({
    summary: 'Put the caller’s own saved filters of a list in a new order',
    description:
      'Needs the list’s view permission. `ids` must name every filter the caller owns in the ' +
      'list exactly once; otherwise validation.failed on `ids` and the panel reads the list again.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFiltersReorderRequest })
  @ApiOkResponse({ type: SavedFiltersReorderedDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async reorderFilters(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SavedFiltersReorderedDto> {
    const input = closedBody(request, body, ['listKey', 'ids']);
    if (input instanceof HttpException) throw input;
    const result = await this.reorder.execute(context, input);
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SavedFiltersReorderedDto;
  }

  @Put(':id')
  @ReadsSession()
  @ApiOperation({
    summary: 'Rename a saved filter and set who can use it',
    description:
      'Needs the list’s view permission. Sets `name` and `visibility`; the document never ' +
      'changes. The owner may always; anybody with the share permission may also change a filter ' +
      'shared with everyone. A filter of another list or another member’s private filter is ' +
      'saved-filter.not-found. Changes to or from everyone are audited.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterUpdateRequest })
  @ApiOkResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ description: 'saved-filter.not-found' })
  @ApiConflictResponse({
    description: 'saved-filter.name-taken or saved-filter.shared-limit-reached (details.max)',
  })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async updateFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SavedFilterDto> {
    const input = closedBody(request, body, ['listKey', 'name', 'visibility']);
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
      'Needs the list’s view permission. The owner may always; anybody with the share ' +
      'permission may also delete a filter shared with everyone. Deleting a shared filter is audited.',
  })
  @ApiParam(ID_PARAM)
  @ApiQuery({ name: 'listKey', required: true })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SavedFilterDeletedDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ description: 'saved-filter.not-found' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async deleteFilter(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<SavedFilterDeletedDto> {
    const result = await this.remove.execute(context, { ...query, id });
    if (!result.ok) throw refusalWith(SAVED_FILTER_STATUS, result.error, response, context);
    return result.value;
  }
}
