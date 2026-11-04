import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ServiceAreaNamesEdit } from '../application/use-cases/service-area-names-edit.use-case';
import { ServiceAreaNamesList } from '../application/use-cases/service-area-names-list.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import {
  ServiceAreaNamesBody,
  ServiceAreaNamesEditBody,
  ServiceAreaNamesEditRequest,
} from './service-area-names.dto';

/**
 * The admin page of service area names over HTTP (ADR-0041). A thin adapter: the `CallContext`
 * comes from `@Call()` and the admin session cookie of the request's Market; the controller
 * authenticates only. Who may list is `sellers.seller.view` and who may edit is
 * `sellers.service-area.edit`, both checked by the use cases. Every response is `no-store`.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@Controller('sellers/admin/service-areas')
export class ServiceAreaNamesController {
  constructor(
    private readonly list: ServiceAreaNamesList,
    private readonly edit: ServiceAreaNamesEdit,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'List service areas with their names (admin)',
    description:
      'Every service area of the Market with its names in each supported language, marking ' +
      'the edited ones. Needs sellers.seller.view.',
  })
  @ApiOkResponse({ type: ServiceAreaNamesBody })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: 'session.invalid' })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  async listAreas(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ServiceAreaNamesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, undefined);
    if (!result.ok) throw errorOf(result.error, response);
    return {
      defaultLanguage: result.value.defaultLanguage,
      languages: [...result.value.languages],
      areas: result.value.areas.map((area) => ({ ...area, names: { ...area.names } })),
    };
  }

  @Post('names')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Edit the names of one service area (admin)',
    description:
      'Sets the display name of one area in one or more languages, or restores the configured ' +
      'name of a language (null). Only names change: the code, postcodes and flags are ' +
      'configuration. Needs sellers.service-area.edit.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ServiceAreaNamesEditRequest })
  @ApiOkResponse({ type: ServiceAreaNamesEditBody })
  @ApiBadRequestResponse({ type: SellersErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: SellersErrorBody, description: 'session.invalid' })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: SellersErrorBody, description: 'service-area.not-found' })
  @ApiUnsupportedMediaTypeResponse({ type: SellersErrorBody, description: 'Not application/json' })
  async editNames(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ServiceAreaNamesEditBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.edit.execute(context, body);
    if (!result.ok) throw errorOf(result.error, response);
    return {
      changed: result.value.changed,
      area: { ...result.value.area, names: { ...result.value.area.names } },
    };
  }
}
