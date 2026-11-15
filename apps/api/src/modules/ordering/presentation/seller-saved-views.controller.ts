import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
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
import { closedBody, refusal } from './http-answers';
import {
  SAVED_FILTER_LIST_KEYS,
  SavedFilterCreateRequest,
  SavedFilterDeletedDto,
  SavedFilterDto,
  SavedFilterListDto,
  SavedFilterUpdateRequest,
} from './saved-views.dto';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ID_PARAM = { name: 'id', description: 'The saved filter id (a UUID v7).' };
const LIST_KEY = { name: 'listKey', required: true, enum: SAVED_FILTER_LIST_KEYS };

/**
 * The saved filters of the seller order list over HTTP: list, create, rename,
 * delete. A seller filter is the caller\u2019s own; nothing is shared.
 * Every answer is `Cache-Control: no-store`; a write needs the CSRF token.
 */
@ApiTags('ordering')
@RoutePopulation('seller')
@ReadsSession()
@Controller('ordering/seller')
export class SellerSavedViewsController {
  readonly #logger = new Logger('SellerSavedViewsController');

  constructor(
    private readonly list: SellerSavedFiltersList,
    private readonly create: SellerSavedFilterCreate,
    private readonly update: SellerSavedFilterUpdate,
    private readonly remove: SellerSavedFilterDelete,
  ) {}

  @Get('saved-filters')
  @ApiOperation({
    summary: 'List the saved filters of the seller order list',
    description: 'Needs ordering.seller-order.view. The caller\u2019s own filters first.',
  })
  @ApiQuery(LIST_KEY)
  @ApiOkResponse({ type: SavedFilterListDto })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listFilters(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<SavedFilterListDto> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, { ...query });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterListDto;
  }

  @Post('saved-filters')
  @ApiOperation({
    summary: 'Save the tab, filters and sort of the seller order list under a name',
    description:
      'Needs ordering.seller-order.view. `payload` is a closed document (v 1, tab, optional filters and sort); an unknown key is refused. At most 50 filters per account and list ' +
      '(saved-filter.limit-reached); a seller filter is always me. A name is one per owner, whatever its case (saved-filter.name-taken).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterCreateRequest })
  @ApiCreatedResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'saved-filter.name-taken or a limit (details.max)',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async createFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SavedFilterDto> {
    response.setHeader('Cache-Control', 'no-store');
    const input = closedBody(request, body, ['listKey', 'name', 'visibility', 'payload']);
    if (input instanceof HttpException) throw input;
    const result = await this.create.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterDto;
  }

  @Put('saved-filters/:id')
  @ApiOperation({
    summary: 'Rename a saved filter',
    description:
      'Needs ordering.seller-order.view. The document of a filter never changes. The owner may always. ' +
      'A filter the caller cannot see is saved-filter.not-found.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SavedFilterUpdateRequest })
  @ApiOkResponse({ type: SavedFilterDto })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'saved-filter.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'saved-filter.name-taken or saved-filter.shared-limit-reached',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async updateFilter(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<SavedFilterDto> {
    response.setHeader('Cache-Control', 'no-store');
    const input = closedBody(request, body, ['name', 'visibility']);
    if (input instanceof HttpException) throw input;
    const result = await this.update.execute(context, { ...(body as object), id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return JSON.parse(JSON.stringify(result.value)) as SavedFilterDto;
  }

  @Delete('saved-filters/:id')
  @ApiOperation({
    summary: 'Delete a saved filter',
    description: 'Needs ordering.seller-order.view. Who may: as for the rename.',
  })
  @ApiParam(ID_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SavedFilterDeletedDto })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'saved-filter.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async deleteFilter(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ): Promise<SavedFilterDeletedDto> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, { id });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
