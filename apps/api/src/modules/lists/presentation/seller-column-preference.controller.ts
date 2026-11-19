import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
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
import { SellerColumnPreferenceGet } from '../application/use-cases/seller-column-preference-get.use-case';
import { SellerColumnPreferenceReset } from '../application/use-cases/seller-column-preference-reset.use-case';
import { SellerColumnPreferenceSave } from '../application/use-cases/seller-column-preference-save.use-case';
import { ColumnPreferenceDto, ColumnPreferenceSaveRequest } from './column-preference.dto';
import { closedBody, refusalWith } from './http-answers';

/** The refusals of the column-preference routes: a malformed request is 400, a missing dependency 503. */
export const COLUMN_PREFERENCE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.unavailable': 503,
  'access.acting-as-refused': 403,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The column choice of a seller per list (super list B0-2), kept on the account instead of in one
 * browser. Needs the list's view permission; a write needs the CSRF token and the panel's origin.
 */
@ApiTags('lists')
@RoutePopulation('seller')
@Controller('lists/seller/column-preferences')
export class ListsSellerColumnPreferenceController {
  constructor(
    private readonly read: SellerColumnPreferenceGet,
    private readonly save: SellerColumnPreferenceSave,
    private readonly reset: SellerColumnPreferenceReset,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({ summary: 'Read the caller’s saved columns of a seller list' })
  @ApiQuery({ name: 'listKey', required: true })
  @ApiOkResponse({ type: ColumnPreferenceDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async readColumns(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ColumnPreferenceDto> {
    const result = await this.read.execute(context, { ...query });
    if (!result.ok) throw refusalWith(COLUMN_PREFERENCE_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as ColumnPreferenceDto;
  }

  @Put()
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the caller’s columns of a seller list',
    description: 'Replaces the previous choice. Ids outside the list’s vocabulary are refused.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ColumnPreferenceSaveRequest })
  @ApiOkResponse({ type: ColumnPreferenceDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async saveColumns(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ColumnPreferenceDto> {
    const input = closedBody(request, body, ['listKey', 'columns']);
    if (input instanceof HttpException) throw input;
    const result = await this.save.execute(context, input);
    if (!result.ok) throw refusalWith(COLUMN_PREFERENCE_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as ColumnPreferenceDto;
  }

  @Delete()
  @ReadsSession()
  @ApiOperation({ summary: 'Forget the caller’s columns of a seller list (back to the default)' })
  @ApiQuery({ name: 'listKey', required: true })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: ColumnPreferenceDto })
  @ApiBadRequestResponse({ description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  @ApiForbiddenResponse({ description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ description: 'access.unavailable' })
  async resetColumns(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ColumnPreferenceDto> {
    const result = await this.reset.execute(context, { ...query });
    if (!result.ok) throw refusalWith(COLUMN_PREFERENCE_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as ColumnPreferenceDto;
  }
}
