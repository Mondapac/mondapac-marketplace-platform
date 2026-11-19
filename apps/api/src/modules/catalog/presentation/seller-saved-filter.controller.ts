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
import { OwnSavedFilterCreate } from '../application/use-cases/own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from '../application/use-cases/own-saved-filter-delete.use-case';
import { OwnSavedFilterUpdate } from '../application/use-cases/own-saved-filter-update.use-case';
import {
  OwnSavedFiltersList,
  SELLER_SAVED_FILTER_LIST_KEYS,
} from '../application/use-cases/own-saved-filters-list.use-case';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  SellerSavedFilterCreateRequest,
  SellerSavedFilterDeletedDto,
  SellerSavedFilterDto,
  SellerSavedFilterListDto,
  SellerSavedFilterUpdateRequest,
} from './seller-saved-filter.dto';

/**
 * The HTTP status of each refusal of the seller saved-filter routes (catalog design 9.2d). A
 * malformed request is 400; a filter that is unknown, that belongs to another store or that
 * somebody else keeps for themselves is 404 (the same answer); a name already used and the two caps
 * are 409; a missing dependency is 503. `access.denied` (including "everyone" without the share
 * key) is 403 from the platform table, and so is a Login-as-Seller session on a write.
 */
export const SELLER_SAVED_FILTER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'saved-filter.not-found': 404,
  'saved-filter.name-taken': 409,
  'saved-filter.limit-reached': 409,
  'saved-filter.shared-limit-reached': 409,
  'access.acting-as-refused': 403,
  'access.unavailable': 503,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const ID_PARAM = { name: 'id', description: 'The saved filter id (a UUID v7).' };

/**
 * The saved filters of the seller Products list over HTTP (catalog design 9.2d): list, create,
 * rename and set who can use one, delete. Seller routes read the seller session, so a write needs
 * the CSRF token and the panel's origin. The store is always the signed-in seller's, never from
 * the request. A thin adapter: one use case each does the work through its gate.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/saved-filters')
export class SellerSavedFilterController {
  constructor(
    private readonly list: OwnSavedFiltersList,
    private readonly create: OwnSavedFilterCreate,
    private readonly update: OwnSavedFilterUpdate,
    private readonly remove: OwnSavedFilterDelete,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the saved filters of the seller Products list',
    description:
      'Needs catalog.own-product.view. The caller’s own filters first, then the ones other ' +
      'members of the same store shared with everyone, each group oldest first. Each has its ' +
      'document, `ownedByMe` and `canManage`. `canShare` says whether the caller holds ' +
      'catalog.own-saved-filter.share. A filter of another store is never listed.',
  })
  @ApiQuery({ name: 'listKey', required: true, enum: SELLER_SAVED_FILTER_LIST_KEYS })
  @ApiOkResponse({ type: SellerSavedFilterListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async listFilters(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<SellerSavedFilterListDto> {
    const result = await this.list.execute(context, { ...query });
    if (!result.ok) {
      throw refusalWith(SELLER_SAVED_FILTER_STATUS, result.error, response, context);
    }
    return JSON.parse(JSON.stringify(result.value)) as SellerSavedFilterListDto;
  }

  @Post()
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the tab, search, filters and sort of the Products list under a name',
    description:
      'Needs catalog.own-product.view. `visibility` is me or everyone (everyone in the store); ' +
      'everyone also needs catalog.own-saved-filter.share (else access.denied). `payload` is the ' +
      'closed selector of the list: v 1, view, q, status, categoryId, paused, typeCode, sort and ' +
      'direction, each read as the list reads it; a page key or an unknown key is refused. At ' +
      'most 50 filters per member and list (saved-filter.limit-reached) and 20 shared with the ' +
      'store per list (saved-filter.shared-limit-reached, details.max). A name is one per member ' +
      'and, among shared filters, one per store and list, whatever its case ' +
      '(saved-filter.name-taken). A filter shared with the store is audited. Refused in a ' +
      'Login-as-Seller session.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerSavedFilterCreateRequest })
  @ApiCreatedResponse({ type: SellerSavedFilterDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, access.acting-as-refused or request.csrf',
  })
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
  ): Promise<SellerSavedFilterDto> {
    const input = closedBody(request, body, ['listKey', 'name', 'visibility', 'payload']);
    if (input instanceof HttpException) throw input;
    const result = await this.create.execute(context, input);
    if (!result.ok) {
      throw refusalWith(SELLER_SAVED_FILTER_STATUS, result.error, response, context);
    }
    return JSON.parse(JSON.stringify(result.value)) as SellerSavedFilterDto;
  }

  @Put(':id')
  @ReadsSession()
  @ApiOperation({
    summary: 'Rename a saved filter and set who can use it',
    description:
      'Needs catalog.own-product.view. Sets `name` and `visibility` (both); the document of a ' +
      'filter never changes. The owner may always; any member with ' +
      'catalog.own-saved-filter.share may also change a filter shared with the store. Making a ' +
      'filter everyone needs the share key for everybody. Another member’s private filter and a ' +
      'filter of another store are saved-filter.not-found. Changes to or from everyone are ' +
      'audited. Refused in a Login-as-Seller session.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerSavedFilterUpdateRequest })
  @ApiOkResponse({ type: SellerSavedFilterDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, access.acting-as-refused or request.csrf',
  })
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
  ): Promise<SellerSavedFilterDto> {
    const input = closedBody(request, body, ['name', 'visibility']);
    if (input instanceof HttpException) throw input;
    const result = await this.update.execute(context, { ...input, id });
    if (!result.ok) {
      throw refusalWith(SELLER_SAVED_FILTER_STATUS, result.error, response, context);
    }
    return JSON.parse(JSON.stringify(result.value)) as SellerSavedFilterDto;
  }

  @Delete(':id')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete a saved filter',
    description:
      'Needs catalog.own-product.view. The owner may always; any member with ' +
      'catalog.own-saved-filter.share may also delete a filter shared with the store. Another ' +
      'member’s private filter and a filter of another store are saved-filter.not-found. ' +
      'Deleting a shared filter is audited. Refused in a Login-as-Seller session.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SellerSavedFilterDeletedDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, access.acting-as-refused or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'saved-filter.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async deleteFilter(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<SellerSavedFilterDeletedDto> {
    const result = await this.remove.execute(context, { id });
    if (!result.ok) {
      throw refusalWith(SELLER_SAVED_FILTER_STATUS, result.error, response, context);
    }
    return result.value;
  }
}
