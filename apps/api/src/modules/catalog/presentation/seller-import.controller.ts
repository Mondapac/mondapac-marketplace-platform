import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
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
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import { OwnImportAddPhoto } from '../application/use-cases/own-import-add-photo.use-case';
import { OwnImportCheck } from '../application/use-cases/own-import-check.use-case';
import { OwnImportDiscard } from '../application/use-cases/own-import-discard.use-case';
import { OwnImportResume } from '../application/use-cases/own-import-resume.use-case';
import { OwnImportStart } from '../application/use-cases/own-import-start.use-case';
import { OwnImportRead } from '../application/use-cases/own-import-read.use-case';
import { OwnImportReport } from '../application/use-cases/own-import-report.use-case';
import { OwnImportTemplate } from '../application/use-cases/own-import-template.use-case';
import { closedBody, refusalWith } from './http-answers';
import { PRODUCT_IMAGE_STATUS } from './product-image.controller';
import { ApiErrorBody } from './platform-product.dto';
import {
  SellerImportCheckRequest,
  SellerImportCurrentDto,
  SellerImportDiscardedDto,
  SellerImportDto,
  SellerImportPhotoDto,
  SellerImportPhotoRequest,
  SellerImportStartRequest,
  SellerImportTemplateDto,
} from './seller-import.dto';

/**
 * The HTTP status of each refusal of the seller import routes (catalog design 14c). A file the check
 * cannot read is a 4xx that says why: too large (413), not a CSV or XLSX (415), unreadable, over the
 * row, column or cell limit, empty or with the wrong columns (422). A job of another seller or
 * Market and an unknown id are the same 404. A step taken in the wrong state is 409. A mode the
 * Market switched off is 422; the daily row cap is 429 with `Retry-After`.
 */
export const SELLER_IMPORT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  ...PRODUCT_IMAGE_STATUS,
  'validation.failed': 400,
  'access.acting-as-refused': 403,
  'seller.not-eligible': 403,
  'setting.product-creation-off': 422,
  'setting.sell-from-catalogue-off': 422,
  'import.not-found': 404,
  'import.not-confirmable': 409,
  'import.errors-not-skipped': 409,
  'import.nothing-to-import': 409,
  'import.already-running': 409,
  'import.not-resumable': 409,
  'import.access-lost': 409,
  'import.not-discardable': 409,
  'import.report-unavailable': 409,
  'import.daily-rows-reached': 429,
  'import.photos-closed': 409,
  'import.photo-not-named': 422,
  'import.photo-already-added': 409,
  'file.unpacked-too-large': 413,
  'file.empty': 422,
  'file.too-many-columns': 422,
  'file.cell-too-long': 422,
  'file.too-many-rows': 422,
  'file.no-rows': 422,
  'file.formula-cell': 422,
  'file.too-complex': 422,
  'file.busy': 503,
  'columns.missing': 422,
  'columns.duplicate': 422,
  'request.throttled': 429,
  'access.unavailable': 503,
});

/** The upload arrives as bytes (its body parser takes the larger limit); anything else stays as it is and `closedBody` refuses it. */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const IMPORT_PARAM = { name: 'importId', description: 'The import. A UUID v7.' };

/**
 * The Import page of Catalogue > Products in the seller panel over HTTP (catalog design 14c): the
 * templates, the upload and check, the confirm, the progress, the report and the photo step. The
 * seller is always the signed-in seller's, never from the request. Seller routes read the seller
 * session, so every unsafe method needs the CSRF token and the panel's origin. Thin adapters: one
 * use case each. No route reaches a row use case: only the import run does.
 */
@ApiTags('catalog')
@RoutePopulation('seller')
@Controller('catalog/seller/imports')
export class SellerImportController {
  constructor(
    private readonly check: OwnImportCheck,
    private readonly start: OwnImportStart,
    private readonly read: OwnImportRead,
    private readonly report: OwnImportReport,
    private readonly template: OwnImportTemplate,
    private readonly discard: OwnImportDiscard,
    private readonly resume: OwnImportResume,
    private readonly addPhoto: OwnImportAddPhoto,
  ) {}

  @Get('template')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The import templates and column guide',
    description:
      'Needs catalog.own-product.view. One template per mode, as CSV text in `csv` and an XLSX file ' +
      'as base64 in `xlsx`.',
  })
  @ApiOkResponse({ type: SellerImportTemplateDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async getTemplate(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerImportTemplateDto> {
    const result = await this.template.execute(context, {});
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SellerImportTemplateDto;
  }

  @Get('current')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The seller’s latest import',
    description:
      'Needs catalog.own-product.view. The page opens on it, so an import in progress or an ' +
      'unconfirmed check is found again after the page is left. `import` is null when there is none.',
  })
  @ApiOkResponse({ type: SellerImportCurrentDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async current(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerImportCurrentDto> {
    const result = await this.read.execute(context, { importId: null });
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify({ import: result.value })) as SellerImportCurrentDto;
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Upload a file and check it',
    description:
      'Needs catalog.own-import.run and catalog.own-product.edit. Reads and checks the file and ' +
      'saves nothing but the check’s record: no product, no Offer. The file goes to private object ' +
      'storage, never the database, and is deleted after the retention. Twenty uploads an hour per ' +
      'seller. The earlier unconfirmed check of the account is discarded. A column about ' +
      'certification, price, cost or stock is listed as ignored and never read.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerImportCheckRequest })
  @ApiCreatedResponse({ type: SellerImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, access.acting-as-refused, seller.not-eligible or request.csrf',
  })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'file.too-large or file.unpacked-too-large (details.maxBytes)',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: ApiErrorBody,
    description: 'file.unsupported-type (details.detected), or not application/json',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'setting.product-creation-off, setting.sell-from-catalogue-off, file.empty, ' +
      'file.unreadable, file.too-many-rows, file.too-many-columns, file.cell-too-long, ' +
      'file.no-rows, file.formula-cell, file.too-complex, columns.missing and columns.duplicate',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable, or file.busy (Retry-After)',
  })
  async upload(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerImportDto> {
    const input = closedBody(request, jsonOf(body), ['mode', 'data'], ['fileName']);
    if (input instanceof HttpException) throw input;
    const result = await this.check.execute(context, input as never);
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SellerImportDto;
  }

  @Get(':importId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read an import',
    description:
      'Needs catalog.own-product.view. The counts, the error lines of a check, the failures of a ' +
      'run and its progress. Another seller’s import is import.not-found.',
  })
  @ApiParam(IMPORT_PARAM)
  @ApiOkResponse({ type: SellerImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<SellerImportDto> {
    const result = await this.read.execute(context, { importId });
    if (!result.ok || result.value === null) {
      throw refusalWith(
        SELLER_IMPORT_STATUS,
        result.ok ? { code: 'import.not-found' } : result.error,
        response,
        context,
      );
    }
    return JSON.parse(JSON.stringify(result.value)) as SellerImportDto;
  }

  @Post(':importId/start')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Confirm the import',
    description:
      'Needs catalog.own-import.run and catalog.own-product.edit. Only the account that uploaded ' +
      'the file. A file with errors needs `skipErrors: true`. Five imports start a day, one runs at ' +
      'a time, and at most 10,000 rows start in 24 hours. The import is queued and runs in the ' +
      'background as that account. Nothing is submitted or published: products stay drafts.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerImportStartRequest })
  @ApiOkResponse({ type: SellerImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, access.acting-as-refused, seller.not-eligible or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'import.not-confirmable, import.errors-not-skipped, import.nothing-to-import or import.already-running',
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled or import.daily-rows-reached (Retry-After)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirm(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ): Promise<SellerImportDto> {
    const input = closedBody(request, body, ['skipErrors']);
    if (input instanceof HttpException) throw input;
    const result = await this.start.execute(context, { importId, ...input } as never);
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SellerImportDto;
  }

  @Post(':importId/resume')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Retry the rest of an import that stopped part way',
    description:
      'Needs catalog.own-import.run and catalog.own-product.edit. Only the account that started ' +
      'it, only while the file is still stored. Products already made are kept.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SellerImportDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'import.not-resumable, import.access-lost or import.already-running',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resumeImport(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<SellerImportDto> {
    const result = await this.resume.execute(context, { importId });
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SellerImportDto;
  }

  @Post(':importId/discard')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Drop a checked file (Cancel)',
    description:
      'Needs catalog.own-import.run and catalog.own-product.edit. Only the account that uploaded ' +
      'it, and only before it is confirmed. The stored file is deleted.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: SellerImportDiscardedDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'import.not-discardable' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async discardImport(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<SellerImportDiscardedDto> {
    const result = await this.discard.execute(context, { importId });
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return result.value;
  }

  @Get(':importId/report')
  @ReadsSession()
  @ApiOperation({
    summary: 'Download a report',
    description:
      'Needs catalog.own-product.view. `kind=errors` is the check’s error report; `kind=full` the ' +
      'run’s report once it finished or stopped. text/csv; a cell that starts with = + - @ is ' +
      'written with a leading quote. Cells of an ignored column are never in it.',
  })
  @ApiQuery({ name: 'kind', enum: ['errors', 'full'] })
  @ApiOkResponse({ description: 'text/csv; charset=utf-8, as an attachment' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'import.report-unavailable' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Param('importId') importId: string,
    @Query('kind') kind: unknown,
  ): Promise<void> {
    const result = await this.report.execute(context, { importId, kind });
    if (!result.ok) {
      const error = refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, body } = result.value;
    response
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(body);
  }

  @Post(':importId/photos')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add one photo the file named (the photo step)',
    description:
      'Needs catalog.own-import.run and catalog.own-product.edit. For seven days after a ' +
      'my-products import ended. The product comes from the import’s row record, never from the ' +
      'request; the server never opens a ZIP and never fetches a link. Sixty photos a minute and ' +
      '2,000 a day per seller; eight photos per product.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerImportPhotoRequest })
  @ApiCreatedResponse({ type: SellerImportPhotoDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'import.photos-closed, import.photo-already-added or image.limit-reached',
  })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'import.photo-not-named, file.unreadable, file.too-many-pixels or file.too-small',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async photo(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ): Promise<SellerImportPhotoDto> {
    const input = closedBody(request, jsonOf(body), ['name', 'data']);
    if (input instanceof HttpException) throw input;
    const result = await this.addPhoto.execute(context, { importId, ...input } as never);
    if (!result.ok) throw refusalWith(SELLER_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as SellerImportPhotoDto;
  }
}
