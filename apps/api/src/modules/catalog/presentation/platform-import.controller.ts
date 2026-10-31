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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
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
import { PlatformImportDiscard } from '../application/use-cases/platform-import-discard.use-case';
import { PlatformImportResume } from '../application/use-cases/platform-import-resume.use-case';
import { PlatformImportStart } from '../application/use-cases/platform-import-start.use-case';
import { PlatformImportCheck } from '../application/use-cases/platform-import-check.use-case';
import { PlatformImportRead } from '../application/use-cases/platform-import-read.use-case';
import { PlatformImportReport } from '../application/use-cases/platform-import-report.use-case';
import { PlatformImportTemplate } from '../application/use-cases/platform-import-template.use-case';
import { closedBody, refusalWith } from './http-answers';
import {
  PlatformImportCheckRequest,
  PlatformImportCurrentDto,
  PlatformImportDiscardedDto,
  PlatformImportDto,
  PlatformImportStartRequest,
  PlatformImportTemplateDto,
} from './platform-import.dto';
import { ApiErrorBody } from './platform-product.dto';

/**
 * The HTTP status of each refusal of the platform import routes (catalog design 14a). A file the
 * check cannot read is a 4xx that says why: too large (413), not a CSV (415) or unreadable, over the
 * row, column or cell limit, empty, or with the wrong columns (422). A job of another admin or Market
 * and an unknown id are the same 404. A step taken in the wrong state is 409.
 */
export const PLATFORM_IMPORT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'import.pause-not-allowed': 403,
  'import.not-found': 404,
  'import.not-confirmable': 409,
  'import.errors-not-skipped': 409,
  'import.nothing-to-import': 409,
  'import.already-running': 409,
  'import.not-resumable': 409,
  'import.not-discardable': 409,
  'import.report-unavailable': 409,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.empty': 422,
  'file.unreadable': 422,
  'file.too-many-columns': 422,
  'file.cell-too-long': 422,
  'file.too-many-rows': 422,
  'file.no-rows': 422,
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

/**
 * The Import products page of Catalogue > Products over HTTP (catalog design 14a): the template, the
 * upload and check, the confirm, the progress and the report. Admin routes read the admin session, so
 * every unsafe method needs the CSRF token and the panel's origin. Thin adapters: one use case each.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/platform-imports')
export class PlatformImportController {
  constructor(
    private readonly check: PlatformImportCheck,
    private readonly start: PlatformImportStart,
    private readonly read: PlatformImportRead,
    private readonly report: PlatformImportReport,
    private readonly template: PlatformImportTemplate,
    private readonly discard: PlatformImportDiscard,
    private readonly resume: PlatformImportResume,
  ) {}

  @Get('template')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The import template and column guide',
    description: 'Needs catalog.platform-import.run. The template is CSV text in `csv`.',
  })
  @ApiOkResponse({ type: PlatformImportTemplateDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async getTemplate(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformImportTemplateDto> {
    const result = await this.template.execute(context, {});
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as PlatformImportTemplateDto;
  }

  @Get('current')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The admin’s latest import',
    description:
      'Needs catalog.platform-import.run. The page opens on it, so an import in progress or an ' +
      'unconfirmed check is found again after the page is left. `import` is null when there is none.',
  })
  @ApiOkResponse({ type: PlatformImportCurrentDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async current(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformImportCurrentDto> {
    const result = await this.read.execute(context, { importId: null });
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify({ import: result.value })) as PlatformImportCurrentDto;
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Upload a file and check it',
    description:
      'Needs catalog.platform-import.run and catalog.platform-product.edit. Reads and checks the ' +
      'file and saves nothing but the check’s record: no product. The file goes to private object ' +
      'storage, never the database, and is deleted after the retention. Twenty uploads an hour per ' +
      'admin. The earlier unconfirmed check of the admin is discarded.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformImportCheckRequest })
  @ApiCreatedResponse({ type: PlatformImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'file.too-large (details.maxBytes)',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: ApiErrorBody,
    description: 'file.unsupported-type (details.detected), or not application/json',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'file.empty, file.unreadable, file.too-many-rows (details.rows, details.max), ' +
      'file.too-many-columns, file.cell-too-long, file.no-rows, columns.missing and ' +
      'columns.duplicate (details.columns)',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async upload(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PlatformImportDto> {
    const input = closedBody(request, jsonOf(body), ['data'], ['fileName']);
    if (input instanceof HttpException) throw input;
    const result = await this.check.execute(context, input as never);
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as PlatformImportDto;
  }

  @Get(':importId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read an import',
    description:
      'Needs catalog.platform-import.run. The counts, the error lines of a check, the failures of ' +
      'a run and its progress.',
  })
  @ApiOkResponse({ type: PlatformImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async get(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<PlatformImportDto> {
    const result = await this.read.execute(context, { importId });
    if (!result.ok || result.value === null) {
      throw refusalWith(
        PLATFORM_IMPORT_STATUS,
        result.ok ? { code: 'import.not-found' } : result.error,
        response,
        context,
      );
    }
    return JSON.parse(JSON.stringify(result.value)) as PlatformImportDto;
  }

  @Post(':importId/start')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Confirm the import',
    description:
      'Needs catalog.platform-import.run and catalog.platform-product.edit; Inactive also needs ' +
      'catalog.product.pause. Only the admin who uploaded the file. A file with errors needs ' +
      '`skipErrors: true`. The import is queued and runs in the background as that admin.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PlatformImportStartRequest })
  @ApiOkResponse({ type: PlatformImportDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, request.csrf or import.pause-not-allowed',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'import.not-confirmable, import.errors-not-skipped, import.nothing-to-import or import.already-running',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirm(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
    @Body() body: unknown,
  ): Promise<PlatformImportDto> {
    const input = closedBody(request, body, ['startAs', 'skipErrors']);
    if (input instanceof HttpException) throw input;
    const result = await this.start.execute(context, { importId, ...input } as never);
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as PlatformImportDto;
  }

  @Post(':importId/resume')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Retry the rest of an import that stopped part way',
    description:
      'Needs catalog.platform-import.run and catalog.platform-product.edit. Only the admin who ' +
      'started it, only while the file is still stored. Products already added are kept.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: PlatformImportDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'import.not-resumable or import.already-running',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resumeImport(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<PlatformImportDto> {
    const result = await this.resume.execute(context, { importId });
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as PlatformImportDto;
  }

  @Post(':importId/discard')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Drop a checked file (Cancel)',
    description:
      'Needs catalog.platform-import.run. Only the admin who uploaded it, and only before it is ' +
      'confirmed. The stored file is deleted.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: PlatformImportDiscardedDto })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'import.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'import.not-discardable' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async discardImport(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('importId') importId: string,
  ): Promise<PlatformImportDiscardedDto> {
    const result = await this.discard.execute(context, { importId });
    if (!result.ok) throw refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
    return result.value;
  }

  @Get(':importId/report')
  @ReadsSession()
  @ApiOperation({
    summary: 'Download a report',
    description:
      'Needs catalog.platform-import.run. `kind=errors` is the check’s error report; `kind=full` ' +
      'the run’s report once it finished or stopped. text/csv; a cell that starts with = + - @ is ' +
      'written with a leading quote.',
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
      const error = refusalWith(PLATFORM_IMPORT_STATUS, result.error, response, context);
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
}
