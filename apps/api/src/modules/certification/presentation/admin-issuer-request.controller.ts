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
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import {
  IssuerQueueView,
  IssuerRequestAnswerRequest,
  IssuerRequestAnsweredView,
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
