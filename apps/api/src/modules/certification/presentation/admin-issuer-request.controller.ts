import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
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
import { IssuerRequestAnswer } from '../application/use-cases/issuer-request-answer.use-case';
import { IssuerRequestDocumentRead } from '../application/use-cases/issuer-request-document-read.use-case';
import { IssuerRequestRead } from '../application/use-cases/issuer-request-read.use-case';
import { IssuerRequestsQueue } from '../application/use-cases/issuer-requests-queue.use-case';
import { IssuerRequestsExport } from '../application/use-cases/issuer-requests-export.use-case';
import { IssuerRequestsQuery } from '../application/use-cases/issuer-requests-query.use-case';
import {
  ISSUER_REQUEST_EXPORT_COLUMNS,
  ISSUER_REQUEST_LIST_VIEWS,
  ISSUER_REQUEST_SORT_KEYS,
} from '../domain/issuer-request-list';
import { EXPORT_FORMATS, writeChunks } from '../../../platform/list-export';
import { ApiPayloadTooLargeResponse, ApiQuery } from '@nestjs/swagger';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import {
  IssuerQueueView,
  IssuerRequestAnswerRequest,
  IssuerRequestAnsweredView,
  IssuerRequestListView,
  IssuerRequestPageView,
} from './issuer-request.dto';
import { CertificationErrorBody } from './own-certificate.dto';

/**
 * The HTTP status of each refusal of the admin issuer request routes. A malformed request is 400;
 * an unknown request or file is 404; an answered request or one that moved is 409; an answer the
 * rules refuse (unknown or inactive issuer, a reason not in the Market's list) is 422; the file
 * read while its switch is off is 403.
 */
export const ADMIN_ISSUER_REQUEST_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'issuer-request.not-found': 404,
  'batch.too-large': 413,
  'document.not-found': 404,
  'document.download-disabled': 403,
  'issuer-request.already-answered': 409,
  'conflict.stale': 409,
  'issuer.not-found': 422,
  'issuer.not-active': 422,
  'issuer-request.reason-unknown': 422,
});

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The admin queue of "my issuer is not listed" requests (certification design 3.5, 7.2; brief s4
 * b 4): the list, one request with the typed name, its file and the answer. Thin adapters over one
 * use case each; the guard only authenticates (the admin population), the permission and the
 * not-acting-as rule are the use case's.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/issuer-requests')
export class AdminIssuerRequestController {
  readonly #logger = new Logger('AdminIssuerRequestController');

  constructor(
    private readonly queue: IssuerRequestsQueue,
    private readonly listRequests: IssuerRequestsQuery,
    private readonly exportRequests: IssuerRequestsExport,
    private readonly read: IssuerRequestRead,
    private readonly documentRead: IssuerRequestDocumentRead,
    private readonly answer: IssuerRequestAnswer,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The open issuer requests',
    description:
      'Needs certification.issuer.view. Open requests, oldest first; `afterId` and `limit`. No ' +
      'typed name in the list.',
  })
  @ApiOkResponse({ type: IssuerQueueView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getQueue(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<IssuerQueueView> {
    const result = await this.queue.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (result.value as unknown as IssuerQueueView)
      : this.refusal(result.error, response, context);
    return this.settle('certification.issuer-requests-queue', context, outcome);
  }

  // Before `:issuerRequestId`, so `list` and `export` are never read as a request id.
  @Get('list')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The open issuer requests as a super list',
    description:
      'Needs certification.issuer.view. Filters (`type` = a certification type code, `q` = a ' +
      'request id, `sellerId`, `from`/`to` submitted), sort (submitted or type, with direction; ' +
      'oldest first by default), page numbers with a total (`paging=pages`, default) or ' +
      'Previous/Next without one (`paging=prev-next`), the count and each row\u2019s actions. ' +
      'The list reads at most 500 open requests. No typed name in the list. The older queue ' +
      'route keeps its cursor answer.',
  })
  @ApiQuery({ name: 'view', required: false, enum: ISSUER_REQUEST_LIST_VIEWS })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'q', required: false, description: 'A request id, exact.' })
  @ApiQuery({ name: 'sellerId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Submitted at or after (ISO instant).' })
  @ApiQuery({ name: 'to', required: false, description: 'Submitted before (ISO instant).' })
  @ApiQuery({ name: 'sort', required: false, enum: ISSUER_REQUEST_SORT_KEYS })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'paging', required: false, enum: ['pages', 'prev-next'] })
  @ApiQuery({ name: 'page', required: false, description: 'From 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100; default 25.' })
  @ApiOkResponse({ type: IssuerRequestListView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getList(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<IssuerRequestListView> {
    const result = await this.listRequests.execute(context, numbersOf(query));
    const outcome = result.ok
      ? ({
          ...result.value,
          items: result.value.items.map((row) => ({ ...row, actions: [...row.actions] })),
        } as IssuerRequestListView)
      : this.refusal(result.error, response, context);
    return this.settle('certification.issuer-requests-list', context, outcome);
  }

  @Get('export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the open issuer requests of the list as a file',
    description:
      'Needs certification.issuer.view. `format` is csv (default) or xlsx. `columns` is the ' +
      `comma-separated optional columns in the order shown (${ISSUER_REQUEST_EXPORT_COLUMNS.join(', ')}); ` +
      'type, store and submitted are always there. The requests are `ids` (comma-separated, at ' +
      'most 200; an id that is not an open request of the Market refuses the whole file as not ' +
      'found) or the selector keys of the list (refused with batch.too-large when 500 or more ' +
      'requests are open, because the read stops there; pick the rows by id). No typed name, no file. CSV: a text cell that ' +
      'starts with = + - @ gets a leading quote. XLSX: every cell is a string value.',
  })
  @ApiQuery({ name: 'format', required: false, enum: EXPORT_FORMATS })
  @ApiQuery({ name: 'columns', required: false })
  @ApiQuery({ name: 'ids', required: false })
  @ApiOkResponse({
    description: 'issuer-requests-<date>.csv or issuer-requests-<date>.xlsx, as an attachment',
  })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'issuer-request.not-found' })
  @ApiPayloadTooLargeResponse({
    type: CertificationErrorBody,
    description: 'batch.too-large (max, total)',
  })
  async download(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.exportRequests.execute(context, { ...query });
    this.#logger.log({
      msg: 'certification.issuer-requests-export',
      outcome: result.ok ? 'export' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) {
      const error = this.refusal(result.error, response, context);
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
        msg: 'certification.issuer-requests-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Get(':issuerRequestId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'One issuer request',
    description:
      'Needs certification.issuer.view. The typed issuer name decrypted (seller text, shown as ' +
      'plain text), the files, the active issuers of the type and the Market reasons. Each read ' +
      'is audited.',
  })
  @ApiOkResponse({ type: IssuerRequestPageView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'issuer-request.not-found' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerRequestId') issuerRequestId: string,
  ): Promise<IssuerRequestPageView> {
    const result = await this.read.execute(context, { issuerRequestId });
    const outcome = result.ok
      ? (result.value as unknown as IssuerRequestPageView)
      : this.refusal(result.error, response, context);
    return this.settle('certification.issuer-request-read', context, outcome);
  }

  @Get(':issuerRequestId/documents/:documentId')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @ApiOperation({
    summary: 'Read the file of an issuer request',
    description:
      'Needs certification.issuer.view. Off unless CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED is ' +
      'true (403 document.download-disabled). An octet-stream attachment with a server-made file ' +
      'name, audited.',
  })
  @ApiOkResponse({ description: 'The file bytes as application/octet-stream (attachment)' })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, document.download-disabled',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'document.not-found' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getDocument(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerRequestId') issuerRequestId: string,
    @Param('documentId') documentId: string,
  ): Promise<StreamableFile> {
    const result = await this.documentRead.execute(context, { issuerRequestId, documentId });
    const outcome = result.ok
      ? new StreamableFile(result.value.bytes, {
          type: 'application/octet-stream',
          disposition: `attachment; filename="issuer-request-${documentId}.${EXTENSION[result.value.contentType]}"`,
        })
      : this.refusal(result.error, response, context);
    return this.settle('certification.issuer-request-document-read', context, outcome);
  }

  @Post(':issuerRequestId/answer')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Answer an issuer request',
    description:
      'Needs certification.issuer.edit (protected: no default role holds it; the Platform ' +
      'Administrator grants it). Once, under the version read: issuer-added names an active ' +
      'issuer of the request type that was created in the registry first; not-accepted gives a ' +
      'reason code of the Market. The seller gets a mail.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerRequestAnswerRequest })
  @ApiOkResponse({ type: IssuerRequestAnsweredView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'issuer-request.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'issuer-request.already-answered, conflict.stale',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'issuer.not-found, issuer.not-active, issuer-request.reason-unknown',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postAnswer(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerRequestId') issuerRequestId: string,
    @Body() body: unknown,
  ): Promise<IssuerRequestAnsweredView> {
    const input = closedBody(request, body, ['version', 'outcome'], ['issuerId', 'reasonCode']);
    let outcome: IssuerRequestAnsweredView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.answer.execute(context, {
        issuerRequestId,
        version: input.version,
        outcome: input.outcome,
        issuerId: input.issuerId,
        reasonCode: input.reasonCode,
      });
      outcome = result.ok ? result.value : this.refusal(result.error, response, context);
    }
    return this.settle('certification.issuer-request-answer', context, outcome);
  }

  private refusal(error: Refusal, response: Response, context: CallContext): HttpException {
    return refusalWith(
      ADMIN_ISSUER_REQUEST_STATUS,
      error,
      response,
      context,
      'certification.admin-issuer-request-unmapped-refusal',
    );
  }

  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
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

/** `page` and `pageSize` become numbers (or -1, which the use case refuses). */
function numbersOf(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined) {
      out[key] = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : -1;
    }
  }
  return out;
}
