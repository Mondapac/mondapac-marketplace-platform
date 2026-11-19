import {
  Body,
  Controller,
  Get,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CategoryImportApply } from '../application/use-cases/category-import-apply.use-case';
import { CategoryImportDryRun } from '../application/use-cases/category-import-dry-run.use-case';
import { CategoryTreeExport } from '../application/use-cases/category-tree-export.use-case';
import { closedBody, refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import { writeChunks } from './write-chunks';

/**
 * The HTTP status of each refusal of the category tree import and export routes (categories C7a).
 * A file the reader cannot take is a 4xx that says why (too large 413, not a CSV or XLSX 415,
 * unreadable, over a limit or with the wrong columns 422); a tree or a file that is no longer the
 * one the dry run read is 409. Row problems are not refusals: they are in the dry run's rows.
 */
export const CATEGORY_IMPORT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'request.body-unsupported': 415,
  'conflict.stale': 409,
  'import.file-changed': 409,
  'import.has-errors': 409,
  'import.columns-invalid': 422,
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
  'category.parent-not-found': 404,
  'category.not-found': 404,
  'category.not-editable': 409,
  'category.slug-taken': 409,
  'category.sibling-name-taken': 409,
  'category.depth-exceeded': 422,
  'category.required-locale-missing': 422,
  'category.claim-word': 422,
  'category.locale-uncheckable': 422,
  'claim-text.check-unavailable': 503,
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

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const IMPORT_KEY =
  'Needs the protected key catalog.category-tree.import; refused in an acting-as session.';

/**
 * Import and export of the category tree for the admin panel (categories package C7a). A thin
 * adapter over three use cases. The dry run and the apply take the file as base64 in `data`.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/category-tree')
export class CategoryImportController {
  readonly #logger = new Logger('CategoryImportController');

  constructor(
    private readonly dryRun: CategoryImportDryRun,
    private readonly apply: CategoryImportApply,
    private readonly exportTree: CategoryTreeExport,
  ) {}

  @Post('import/dry-run')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Check a category tree file (nothing is written)',
    description:
      `${IMPORT_KEY} \`data\` is a CSV or XLSX file as base64, within the Market's file size and ` +
      'row caps. Answers per row: create, update, unchanged or error (with a code), the file ' +
      'SHA-256 and the tree version the apply must name. Create and update only: a row that names ' +
      'another parent than the category has is `move.not-supported`.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ description: 'fileSha256, treeVersion, format, counts, clean, rows' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'file.too-large' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'file.unsupported-type' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'file.* or import.columns-invalid (details.fields)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable, claim-text.check-unavailable or file.busy',
  })
  async postDryRun(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<object> {
    return this.run(
      'catalog.category-import-dry-run',
      context,
      response,
      request,
      body,
      ['data'],
      (input) => this.dryRun.execute(context, input),
    );
  }

  @Post('import/apply')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Apply a category tree file with a clean dry run',
    description:
      `${IMPORT_KEY} Send the same file with the \`fileSha256\` and \`treeVersion\` of its dry ` +
      'run. A different file is import.file-changed; a tree that changed since is conflict.stale; ' +
      'any error row is import.has-errors and nothing is written. One unit, one tree version raise.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ description: 'fileSha256, treeVersion, counts, written' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'conflict.stale, import.file-changed, import.has-errors, category.slug-taken or category.sibling-name-taken',
  })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description: 'file.* or import.columns-invalid',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async postApply(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<object> {
    return this.run(
      'catalog.category-import-apply',
      context,
      response,
      request,
      body,
      ['data', 'fileSha256', 'treeVersion'],
      (input) => this.apply.execute(context, input),
    );
  }

  @Get('export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Download the category tree as a file',
    description:
      `${IMPORT_KEY.replace('; refused', ' (the same key as the import); refused')} \`format\` is csv ` +
      '(the default) or xlsx. `status` is a comma-separated list of active, hidden, merged, ' +
      'archived (default active,hidden); `q` matches part of a slug or a name. The file streams as ' +
      'an attachment. CSV: a text cell that starts with = + - @ is written with a leading quote ' +
      'that the import takes off. XLSX: every cell is a string value, never a formula.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOkResponse({ description: 'text/csv; charset=utf-8 or an .xlsx file, as an attachment' })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportTree.execute(context, { ...query });
    if (!result.ok) {
      const error = refusalWith(CATEGORY_IMPORT_STATUS, result.error, response, context);
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
      this.#logger.warn({
        msg: 'catalog.category-tree-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  private async run(
    msg: string,
    context: CallContext,
    response: Response,
    request: Request,
    body: unknown,
    keys: readonly string[],
    execute: (
      input: Record<string, unknown>,
    ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }>,
  ): Promise<object> {
    const input = closedBody(request, jsonOf(body), keys);
    let outcome: object | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await execute(input);
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as object)
        : refusalWith(CATEGORY_IMPORT_STATUS, result.error, response, context);
    }
    const failed = outcome instanceof HttpException && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome:
        outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
