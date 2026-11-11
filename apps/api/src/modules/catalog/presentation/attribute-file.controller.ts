import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
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
  ApiOkResponse,
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
import {
  ATTRIBUTE_EXPORT_KINDS,
  ATTRIBUTE_EXPORT_MAX_ROWS,
  AttributeFilesExport,
} from '../application/use-cases/attribute-files-export.use-case';
import { AttributeImportCheck } from '../application/use-cases/attribute-import-check.use-case';
import { AttributeImportRun } from '../application/use-cases/attribute-import-run.use-case';
import {
  AttributeImportCheckBody,
  AttributeImportCheckRequest,
  AttributeImportRunBody,
  AttributeImportRunRequest,
} from './attribute-file.dto';
import { closedBody, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import { writeChunks } from './write-chunks';

/**
 * The HTTP status of each refusal of the attribute file routes (attributes plan, package A9). A
 * malformed query or body is 400; a file the check cannot read is a 4xx that says why (too large
 * 413, not a CSV or XLSX 415, over the row, column or cell limit, empty or with the wrong columns
 * 422); a step taken on a file that is not the checked one, or on one with errors, is 409; an
 * export over the cap is 413; a missing dependency is 503.
 */
export const ATTRIBUTE_FILE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'batch.too-large': 413,
  'file.too-large': 413,
  'file.unpacked-too-large': 413,
  'file.unsupported-type': 415,
  'file.empty': 422,
  'file.unreadable': 422,
  'file.too-many-columns': 422,
  'file.cell-too-long': 422,
  'file.too-many-rows': 422,
  'file.no-rows': 422,
  'file.formula-cell': 422,
  'file.too-complex': 422,
  'file.busy': 503,
  'columns.kind-unknown': 422,
  'columns.missing': 422,
  'columns.duplicate': 422,
  'import.file-changed': 409,
  'import.errors-not-skipped': 409,
  'import.nothing-to-import': 409,
  'request.throttled': 429,
  'access.unavailable': 503,
});

/** The upload arrives as bytes (its body parser takes the larger limit); anything else stays as it is. */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    ATTRIBUTE_FILE_STATUS,
    error,
    response,
    context,
    'catalog.attribute-file-unmapped-refusal',
  );

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const IMPORT_NEEDS =
  'Needs catalog.attribute.import and catalog.attribute.edit (both protected); refused in an acting-as session.';

/**
 * Export and import of attributes over HTTP (attributes plan, package A9). The export is a file
 * download of the attributes, their values or the feature sets, with a column per language. The
 * import is two steps over the same file: the check shows the diff and saves nothing, the run
 * applies it through the attribute editor's own use cases and answers the result, with a report
 * file. Admin routes read the admin session, so every unsafe method needs the CSRF token and the
 * panel's origin. Thin adapters: one use case each.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class AttributeFileController {
  readonly #logger = new Logger('AttributeFileController');

  constructor(
    private readonly exporter: AttributeFilesExport,
    private readonly check: AttributeImportCheck,
    private readonly run: AttributeImportRun,
  ) {}

  @Get('attribute-files/export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export attributes, values or feature sets as a file',
    description:
      'Needs catalog.attribute.view. `kind` is attributes, values or feature-sets; `format` is csv ' +
      '(the default) or xlsx. One column per language of the Market (`name[<locale>]`, ' +
      '`label[<locale>]`, ...) and the number of products that use each row. `missing=<locale>` ' +
      'keeps only what has no text in that language (not for feature-sets), in the same columns, ' +
      `so the file can be filled in and imported. At most ${ATTRIBUTE_EXPORT_MAX_ROWS} rows; more ` +
      'is batch.too-large. CSV: a cell that starts with = + - @ is written with a leading quote. ' +
      'XLSX: every cell is a string value, never a formula.',
  })
  @ApiQuery({ name: 'kind', enum: ATTRIBUTE_EXPORT_KINDS })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'missing', required: false })
  @ApiOkResponse({ description: 'text/csv or an XLSX workbook, as an attachment' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exporter.execute(context, { ...query });
    if (!result.ok) {
      const error = refusal(result.error, response, context);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'catalog.attribute-files-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Post('attribute-imports/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Check an attributes or values file and show the diff',
    description:
      `${IMPORT_NEEDS} Reads the file and answers, row by row, what the import would do: create, ` +
      'update, no change or an error with the column and a code. Saves nothing. A file cannot ' +
      'change a code, a type or the localizable flag, cannot set or clear material and cannot ' +
      'merge, convert, publish or archive; a cell that differs for those is a row error. A blank ' +
      'cell never clears anything. An empty cell in the default-language column is a row error. ' +
      'Twenty uploads an hour per admin.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeImportCheckRequest })
  @ApiOkResponse({ type: AttributeImportCheckBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'file.too-large or file.unpacked-too-large',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: ApiErrorBody,
    description: 'file.unsupported-type, or not application/json',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'file.empty, file.unreadable, file.too-many-rows, file.too-many-columns, file.cell-too-long, ' +
      'file.no-rows, file.formula-cell, file.too-complex, columns.kind-unknown, columns.missing, columns.duplicate',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or file.busy',
  })
  async checkFile(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AttributeImportCheckBody> {
    const input = closedBody(request, jsonOf(body), ['data'], ['fileName']);
    if (input instanceof HttpException) throw input;
    const result = await this.check.execute(context, input);
    if (!result.ok) throw refusal(result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as AttributeImportCheckBody;
  }

  @Post('attribute-imports/run')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Run a checked attributes or values file',
    description:
      `${IMPORT_NEEDS} Send the same file with the fileSha256 the check answered. Every row goes ` +
      'through the attribute editor (claim-word check of every language, code uniqueness, version ' +
      'check, domain rules), each with its own audit row; a refused attribute fails and the run ' +
      'goes on. A file with errors needs skipErrors: true. The answer counts what happened and ' +
      'carries the result of every row as a CSV report. One audit row, ' +
      'catalog.attribute-import.ran, holds the counts.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AttributeImportRunRequest })
  @ApiOkResponse({ type: AttributeImportRunBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'import.file-changed, import.errors-not-skipped or import.nothing-to-import',
  })
  @ApiPayloadTooLargeResponse({
    type: ApiErrorBody,
    description: 'file.too-large or file.unpacked-too-large',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: ApiErrorBody,
    description: 'file.unsupported-type, or not application/json',
  })
  @ApiUnprocessableEntityResponse({ type: ApiErrorBody, description: 'the codes of the check' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or file.busy',
  })
  async runFile(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AttributeImportRunBody> {
    const input = closedBody(
      request,
      jsonOf(body),
      ['data', 'fileSha256'],
      ['fileName', 'skipErrors'],
    );
    if (input instanceof HttpException) throw input;
    const result = await this.run.execute(context, input);
    if (!result.ok) throw refusal(result.error, response, context);
    return JSON.parse(JSON.stringify(result.value)) as AttributeImportRunBody;
  }
}
