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
  ApiCreatedResponse,
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
import { ApproveSellerCertificate } from '../application/use-cases/seller-certificate-approve.use-case';
import { DeclineSellerCertificate } from '../application/use-cases/seller-certificate-decline.use-case';
import { SellerCertificateRecordCheck } from '../application/use-cases/seller-certificate-record-check.use-case';
import { SellerCertificateRecordConfirmation } from '../application/use-cases/seller-certificate-record-confirmation.use-case';
import { SellerCertificateRecordScope } from '../application/use-cases/seller-certificate-record-scope.use-case';
import { SellerCertificateHistoryRead } from '../application/use-cases/seller-certificate-history-read.use-case';
import { RequestChangesSellerCertificate } from '../application/use-cases/seller-certificate-request-changes.use-case';
import { RevokeSellerCertificate } from '../application/use-cases/seller-certificate-revoke.use-case';
import { SellerCertificateReviewDocumentRead } from '../application/use-cases/seller-certificate-review-document-read.use-case';
import { SellerCertificateReviewRead } from '../application/use-cases/seller-certificate-review-read.use-case';
import { SellerCertificatesQueue } from '../application/use-cases/seller-certificates-queue.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import {
  CertificationErrorBody,
  HistoryView,
  ReviewApproveRequest,
  ReviewCheckRecorded,
  ReviewCheckRequest,
  ReviewConfirmationRecorded,
  ReviewConfirmationRequest,
  ReviewDecided,
  ReviewNegativeDecisionRequest,
  ReviewPageView,
  ReviewQueueView,
  ReviewScopeRecorded,
  ReviewScopeRequest,
  RevokeDone,
  RevokeRequest,
} from './own-certificate.dto';

/**
 * The HTTP status of each refusal of the admin review routes (certification design 7.2). A
 * malformed request is 400; an unknown certificate or file is 404; a submission that is no longer
 * the pending one, a record that moved under the reviewer, or a second confirmation is 409; a
 * decision the rules refuse (checks open, no scope, issuer not active, expired, no zone) is 422;
 * the file download while its switch is off is 403. A revoke of a record that is already revoked,
 * or that was never approved, is 409 (slice 11).
 */
export const ADMIN_REVIEW_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'certificate.not-found': 404,
  'document.not-found': 404,
  'document.download-disabled': 403,
  'review.not-current-submission': 409,
  'certificate.revoked': 409,
  'certificate.not-revocable': 409,
  'confirmation.exists': 409,
  'confirmation.no-issuer': 409,
  'conflict.stale': 409,
  'review.checks-incomplete': 422,
  'review.scope-missing': 422,
  'certificate.incomplete': 422,
  'issuer.not-active': 422,
  'type.inactive': 422,
  'certificate.expired': 422,
  'seller.zone-missing': 422,
});

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    ADMIN_REVIEW_STATUS,
    error,
    response,
    context,
    'certification.admin-review-unmapped-refusal',
  );
}

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const DECISION_COMMON = ['submissionId', 'version'] as const;

/**
 * The admin review of seller certificates: the queue, the review page, the checks, the scope,
 * the issuer confirmation and the three decisions (certification design 3.2, 7.2). Thin adapters
 * over one use case each; the controller guard only authenticates (the admin population), the
 * permission and the not-acting-as rule are the use case's.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/seller-certificates')
export class AdminCertificateReviewController {
  readonly #logger = new Logger('AdminCertificateReviewController');

  constructor(
    private readonly queue: SellerCertificatesQueue,
    private readonly review: SellerCertificateReviewRead,
    private readonly documentRead: SellerCertificateReviewDocumentRead,
    private readonly recordCheck: SellerCertificateRecordCheck,
    private readonly recordScope: SellerCertificateRecordScope,
    private readonly recordConfirmation: SellerCertificateRecordConfirmation,
    private readonly approve: ApproveSellerCertificate,
    private readonly requestChanges: RequestChangesSellerCertificate,
    private readonly decline: DeclineSellerCertificate,
    private readonly revokeCertificate: RevokeSellerCertificate,
    private readonly historyRead: SellerCertificateHistoryRead,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The review queue',
    description:
      'Needs certification.seller-certificate.view. Submissions waiting for a decision, oldest ' +
      'first; `afterId` and `limit`.',
  })
  @ApiOkResponse({ type: ReviewQueueView })
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
  ): Promise<ReviewQueueView> {
    const result = await this.queue.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (result.value as unknown as ReviewQueueView)
      : refusal(result.error, response, context);
    return this.settle('certification.review-queue', context, outcome);
  }

  @Get(':certificateId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The review page of one certificate',
    description:
      'Needs certification.seller-certificate.review. The pending (or last approved) submission ' +
      'with its decrypted fields, files, checks, reasons, duplicate hints, the seller business ' +
      'details and the history. `reason=duplicate-hint` marks a visit from a hint. Each read is ' +
      'audited.',
  })
  @ApiOkResponse({ type: ReviewPageView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getReview(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Query('reason') reason?: unknown,
  ): Promise<ReviewPageView> {
    const result = await this.review.execute(context, { certificateId, reason });
    const outcome = result.ok
      ? (result.value as unknown as ReviewPageView)
      : refusal(result.error, response, context);
    return this.settle('certification.review-read', context, outcome);
  }

  @Get(':certificateId/documents/:documentId')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @ApiOperation({
    summary: 'Read a file of a submission',
    description:
      'Needs certification.seller-certificate.review. Off unless ' +
      'CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED is true (403 document.download-disabled); the ' +
      'review page lists the files either way. Served as an octet-stream attachment with a server-made file name, audited.',
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
    @Param('certificateId') certificateId: string,
    @Param('documentId') documentId: string,
  ): Promise<StreamableFile> {
    const result = await this.documentRead.execute(context, { certificateId, documentId });
    const outcome = result.ok
      ? new StreamableFile(result.value.bytes, {
          // Design 9.4: an original is never served under its own type, and the name is ours.
          type: 'application/octet-stream',
          disposition: `attachment; filename="certificate-${documentId}.${EXTENSION[result.value.contentType]}"`,
        })
      : refusal(result.error, response, context);
    return this.settle('certification.review-document-read', context, outcome);
  }

  @Post(':certificateId/checks')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record the result of one check',
    description:
      'Needs certification.seller-certificate.review. Rows only add; the latest result of a check ' +
      'counts.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewCheckRequest })
  @ApiCreatedResponse({ type: ReviewCheckRecorded })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'review.not-current-submission, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postCheck(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewCheckRecorded> {
    const input = closedBody(request, body, ['submissionId', 'checkCode', 'result']);
    let outcome: ReviewCheckRecorded | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.recordCheck.execute(context, {
        certificateId,
        ...input,
      } as Parameters<(typeof this.recordCheck)['execute']>[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-check', context, outcome);
  }

  @Post(':certificateId/scope')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record the location and scope read from the certificate',
    description:
      'Needs certification.seller-certificate.review. A third-party certificate cannot be ' +
      'approved without it. The texts are stored encrypted.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewScopeRequest })
  @ApiCreatedResponse({ type: ReviewScopeRecorded })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'review.not-current-submission, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postScope(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewScopeRecorded> {
    const input = closedBody(request, body, ['submissionId', 'location', 'scope']);
    let outcome: ReviewScopeRecorded | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.recordScope.execute(context, {
        certificateId,
        ...input,
      } as Parameters<(typeof this.recordScope)['execute']>[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-scope', context, outcome);
  }

  @Post(':certificateId/issuer-confirmation')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record the issuer confirmation of a certificate',
    description:
      'Needs certification.seller-certificate.review. One confirmation per submission, also after ' +
      'approval (a late confirmation). The reference is stored encrypted.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewConfirmationRequest })
  @ApiCreatedResponse({ type: ReviewConfirmationRecorded })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description:
      'review.not-current-submission, confirmation.exists, confirmation.no-issuer, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postConfirmation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewConfirmationRecorded> {
    const input = closedBody(request, body, [
      'submissionId',
      'channelId',
      'confirmedOn',
      'reference',
      'confirmsNumber',
      'confirmsHolder',
    ]);
    let outcome: ReviewConfirmationRecorded | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.recordConfirmation.execute(context, {
        certificateId,
        ...input,
      } as Parameters<(typeof this.recordConfirmation)['execute']>[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-confirmation', context, outcome);
  }

  @Post(':certificateId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve the pending submission',
    description:
      'Needs certification.seller-certificate.approve (a protected key: not in any default ' +
      'role). Names the submission and the record version the reviewer saw; refused when the ' +
      'required checks, scope, active issuer or an unexpired boundary are missing.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewApproveRequest })
  @ApiOkResponse({ type: ReviewDecided })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'review.not-current-submission, conflict.stale',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'review.checks-incomplete (details.fields), review.scope-missing, certificate.incomplete, ' +
      'issuer.not-active, type.inactive, certificate.expired, seller.zone-missing',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postApprove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewDecided> {
    const input = closedBody(request, body, DECISION_COMMON);
    let outcome: ReviewDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.approve.execute(context, { certificateId, ...input } as Parameters<
        (typeof this.approve)['execute']
      >[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-approve', context, outcome);
  }

  @Post(':certificateId/request-changes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask the seller for changes',
    description:
      'Needs certification.seller-certificate.approve (protected; see approve). A reason code of the Market and an optional ' +
      'text; the seller gets a mail with the reason and the next step.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewNegativeDecisionRequest })
  @ApiOkResponse({ type: ReviewDecided })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'review.not-current-submission, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postRequestChanges(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewDecided> {
    const input = closedBody(request, body, [...DECISION_COMMON, 'reasonCode'], ['reasonText']);
    let outcome: ReviewDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.requestChanges.execute(context, {
        certificateId,
        ...input,
      } as Parameters<(typeof this.requestChanges)['execute']>[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-request-changes', context, outcome);
  }

  @Post(':certificateId/decline')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Decline the pending submission',
    description:
      'Needs certification.seller-certificate.approve (protected; see approve). A reason code of the Market and an optional ' +
      'text; the seller gets a mail with the reason and the next step.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReviewNegativeDecisionRequest })
  @ApiOkResponse({ type: ReviewDecided })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'review.not-current-submission, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postDecline(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ReviewDecided> {
    const input = closedBody(request, body, [...DECISION_COMMON, 'reasonCode'], ['reasonText']);
    let outcome: ReviewDecided | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.decline.execute(context, { certificateId, ...input } as Parameters<
        (typeof this.decline)['execute']
      >[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.review-decline', context, outcome);
  }

  @Get(':certificateId/history')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The full status history of one certificate',
    description:
      'Needs certification.document.view (protected: no default role holds it; the Platform ' +
      'Administrator grants it in a custom role). Newest first, paged with `beforeId` and ' +
      '`limit` (1 to 100, default 50): each change with its statuses, submission, actor and ' +
      'instant, the reason code and label, and the decrypted note. Each read is audited (VER-14).',
  })
  @ApiOkResponse({ type: HistoryView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getHistory(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Query('beforeId') beforeId?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<HistoryView> {
    const result = await this.historyRead.execute(context, { certificateId, beforeId, limit });
    const outcome = result.ok
      ? (result.value as unknown as HistoryView)
      : refusal(result.error, response, context);
    return this.settle('certification.history-read', context, outcome);
  }

  @Post(':certificateId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Revoke an approved or expired certificate',
    description:
      'Needs certification.seller-certificate.revoke (protected: no default role holds it; the ' +
      'Platform Administrator grants it in a custom role). Names the record version; a reason ' +
      "code of the Market listed for 'revoked' is required, a note is optional. The record " +
      'becomes revoked (terminal) and no claim is allowed from that instant; a pending renewal is ' +
      'withdrawn; the seller gets a mail with the reason.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RevokeRequest })
  @ApiOkResponse({ type: RevokeDone })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.revoked, certificate.not-revocable, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postRevoke(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<RevokeDone> {
    const input = closedBody(request, body, ['version', 'reasonCode'], ['reasonText']);
    let outcome: RevokeDone | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.revokeCertificate.execute(context, {
        certificateId,
        ...input,
      } as Parameters<(typeof this.revokeCertificate)['execute']>[1]);
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.revoke', context, outcome);
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
