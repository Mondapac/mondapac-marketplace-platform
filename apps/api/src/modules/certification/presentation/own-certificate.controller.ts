import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Put,
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
import { OwnCertificateCreate } from '../application/use-cases/own-certificate-create.use-case';
import { OwnCertificateDeleteDraft } from '../application/use-cases/own-certificate-delete-draft.use-case';
import { OwnCertificateDocumentRead } from '../application/use-cases/own-certificate-document-read.use-case';
import { OwnCertificateOptions } from '../application/use-cases/own-certificate-options.use-case';
import { OwnCertificateRead } from '../application/use-cases/own-certificate-read.use-case';
import { OwnCertificateRemoveDocument } from '../application/use-cases/own-certificate-remove-document.use-case';
import { OwnCertificateSaveDraft } from '../application/use-cases/own-certificate-save-draft.use-case';
import { OwnCertificateSubmit } from '../application/use-cases/own-certificate-submit.use-case';
import { OwnCertificateUploadDocument } from '../application/use-cases/own-certificate-upload-document.use-case';
import { OwnCertificateWithdraw } from '../application/use-cases/own-certificate-withdraw.use-case';
import { OwnCertificatesList } from '../application/use-cases/own-certificates-list.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import {
  CertificateCreateRequest,
  CertificateDeleted,
  CertificateDetailView,
  CertificateDocumentRemoved,
  CertificateDocumentUploaded,
  CertificateDocumentUploadRequest,
  CertificateDraftRequest,
  CertificateDraftSaved,
  CertificateListView,
  CertificateOptionsView,
  CertificateSubmitted,
  CertificateSummaryView,
  CertificationErrorBody,
} from './own-certificate.dto';

/**
 * The HTTP status of each refusal of the seller certificate routes (certification design 7.2).
 * A malformed request is 400; an unknown or foreign certificate, file or type is a byte-identical
 * 404; a record that is not in the state the action needs, or moved under the caller, is 409; a
 * submission the rules refuse (incomplete, expired, inactive issuer, no zone) is 422; a file the
 * intake refuses is 413, 415 or 422; a spent budget is 429; a missing dependency is 503.
 */
export const OWN_CERTIFICATE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'certificate.not-found': 404,
  'document.not-found': 404,
  'type.not-found': 404,
  'type.inactive': 409,
  'certificate.exists': 409,
  'certificate.not-editable': 409,
  'certificate.edit-withdraws-submission': 409,
  'certificate.has-submissions': 409,
  'certificate.has-pending-submission': 409,
  'certificate.not-submittable': 409,
  'certificate.no-pending-submission': 409,
  'document.limit-reached': 409,
  'draft-quota.exceeded': 409,
  'conflict.stale': 409,
  'certificate.incomplete': 422,
  'issuer.not-active': 422,
  'certificate.expired': 422,
  'seller.zone-missing': 422,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.unreadable': 422,
  'file.too-many-pages': 422,
  'file.encrypted': 422,
  'file.active-content': 422,
  'file.too-complex': 422,
  'file.inspection-timeout': 422,
  'request.throttled': 429,
});

const DRAFT_KEYS = [
  'issuerId',
  'certificateNumber',
  'issueDate',
  'expiryDate',
  'selfDeclared',
  'selfDeclarationNote',
] as const;

function refusal(error: Refusal, response: Response, context?: CallContext): HttpException {
  return refusalWith(
    OWN_CERTIFICATE_STATUS,
    error,
    response,
    context,
    'certification.own-certificate-unmapped-refusal',
  );
}

/**
 * The upload arrives as bytes (its body parser takes a larger limit than the JSON one); anything
 * that is not a JSON object stays as it is and `closedBody` refuses it.
 */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The seller's confirmation that an edit withdraws the pending submission (design 3.2 row 2). Only
 * the text `true` confirms; `false` or no value is no confirmation; anything else reaches the use
 * case as it is and is refused there as `validation.failed`.
 */
function withdrawFlag(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

const WITHDRAW_PENDING = {
  name: 'withdrawPending',
  required: false,
  enum: ['true', 'false'],
  description:
    'Confirms that this change withdraws the pending submission (cause edited). Without it a ' +
    'change to a pending certificate is refused with certificate.edit-withdraws-submission and ' +
    'nothing is written.',
};

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The seller's own certificates: create, draft, files, submit, withdraw and read (certification
 * design 3.2, 7.2). Thin adapters over one use case each; the controller guards only
 * authenticate, the rule is the use case's.
 */
@ApiTags('certification')
@RoutePopulation('seller')
@Controller('certification/seller')
export class OwnCertificateController {
  readonly #logger = new Logger('OwnCertificateController');

  constructor(
    private readonly options: OwnCertificateOptions,
    private readonly create: OwnCertificateCreate,
    private readonly list: OwnCertificatesList,
    private readonly read: OwnCertificateRead,
    private readonly saveDraft: OwnCertificateSaveDraft,
    private readonly deleteDraft: OwnCertificateDeleteDraft,
    private readonly submit: OwnCertificateSubmit,
    private readonly withdraw: OwnCertificateWithdraw,
    private readonly uploadDocument: OwnCertificateUploadDocument,
    private readonly removeDocument: OwnCertificateRemoveDocument,
    private readonly readDocument: OwnCertificateDocumentRead,
  ) {}

  @Get('certificate-options')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The certificate types a seller may add',
    description:
      'Needs certification.own-certificate.view. The active types with their form settings and, ' +
      'for a registry type, the active issuers.',
  })
  @ApiOkResponse({ type: CertificateOptionsView })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getOptions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CertificateOptionsView> {
    const result = await this.options.execute(context, {});
    const outcome = result.ok
      ? (result.value as unknown as CertificateOptionsView)
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-options', context, outcome);
  }

  @Get('certificates')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the own certificates',
    description: 'Needs certification.own-certificate.view. Newest first; `afterId` and `limit`.',
  })
  @ApiOkResponse({ type: CertificateListView })
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
  ): Promise<CertificateListView> {
    const result = await this.list.execute(context, pageQuery(query));
    const outcome = result.ok
      ? (result.value as unknown as CertificateListView)
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificates-list', context, outcome);
  }

  @Post('certificates')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Start a certificate of a type',
    description:
      'Needs certification.own-certificate.manage. Creates an empty draft; a seller has one open ' +
      'certificate per type.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: CertificateCreateRequest })
  @ApiCreatedResponse({ type: CertificateSummaryView })
  @ApiBadRequestResponse({ type: CertificationErrorBody, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.exists, type.inactive',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postCreate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CertificateSummaryView> {
    const input = closedBody(request, body, ['typeCode']);
    let outcome: CertificateSummaryView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.create.execute(context, { typeCode: input.typeCode });
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.own-certificate-create', context, outcome);
  }

  @Get('certificates/:certificateId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read an own certificate with its draft and files',
    description: 'Needs certification.own-certificate.view.',
  })
  @ApiOkResponse({ type: CertificateDetailView })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateDetailView> {
    const result = await this.read.execute(context, { certificateId });
    const outcome = result.ok
      ? (result.value as unknown as CertificateDetailView)
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-read', context, outcome);
  }

  @Put('certificates/:certificateId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the draft of an own certificate',
    description:
      'Needs certification.own-certificate.manage. The whole draft, every field present (null ' +
      'clears it). While a submission is pending, a save that changes a value withdraws it ' +
      '(withdrawPending=true required); an unchanged save writes nothing. The approved ' +
      'certificate of a renewal stays valid and untouched.',
  })
  @ApiHeader(CSRF)
  @ApiQuery(WITHDRAW_PENDING)
  @ApiBody({ type: CertificateDraftRequest })
  @ApiOkResponse({ type: CertificateDraftSaved })
  @ApiBadRequestResponse({
    type: CertificationErrorBody,
    description: 'validation.failed (details.fields)',
  })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.not-editable, certificate.edit-withdraws-submission, conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'request.body-unsupported',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async putDraft(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Query('withdrawPending') withdrawPending: unknown,
    @Body() body: unknown,
  ): Promise<CertificateDraftSaved> {
    const input = closedBody(request, body, DRAFT_KEYS);
    let outcome: CertificateDraftSaved | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.saveDraft.execute(context, {
        certificateId,
        draft: input,
        withdrawPending: withdrawFlag(withdrawPending),
      });
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.own-certificate-save-draft', context, outcome);
  }

  @Delete('certificates/:certificateId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete an own certificate that was never submitted',
    description: 'Needs certification.own-certificate.manage. Its files go with it.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: CertificateDeleted })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({ type: CertificationErrorBody, description: 'certificate.has-submissions' })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async removeCertificate(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<{ deleted: true }> {
    const result = await this.deleteDraft.execute(context, { certificateId });
    const outcome = result.ok ? result.value : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-delete-draft', context, outcome);
  }

  @Post('certificates/:certificateId/submit')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Submit an own certificate for review',
    description:
      'Needs certification.own-certificate.manage. The draft becomes an immutable submission; ' +
      'the record goes in-review (a renewal keeps its status).',
  })
  @ApiHeader(CSRF)
  @ApiCreatedResponse({ type: CertificateSubmitted })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.has-pending-submission, certificate.not-submittable, conflict.stale',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'certificate.incomplete (details.fields), issuer.not-active, certificate.expired, seller.zone-missing',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postSubmit(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateSubmitted> {
    const result = await this.submit.execute(context, { certificateId });
    const outcome = result.ok
      ? (result.value as unknown as CertificateSubmitted)
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-submit', context, outcome);
  }

  @Post('certificates/:certificateId/withdraw')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Withdraw the pending submission of an own certificate',
    description:
      'Needs certification.own-certificate.manage. A record never approved goes back to draft.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: CertificateSummaryView })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'certificate.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.no-pending-submission, conflict.stale',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postWithdraw(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateSummaryView> {
    const result = await this.withdraw.execute(context, { certificateId });
    const outcome = result.ok
      ? (result.value as unknown as CertificateSummaryView)
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-withdraw', context, outcome);
  }

  @Post('certificates/:certificateId/documents')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a file to the draft of an own certificate',
    description:
      'Needs certification.own-certificate.manage. A base64 JPEG, PNG or PDF of at most 10 MiB; ' +
      'at most 10 files per certificate and 200 MiB of drafts per seller. The type is read from ' +
      'the content; images are written again without metadata; a PDF with encryption or active ' +
      'content is refused. The file is stored encrypted. While a submission is pending, adding ' +
      'a file withdraws it (withdrawPending=true required).',
  })
  @ApiQuery(WITHDRAW_PENDING)
  @ApiHeader(CSRF)
  @ApiBody({ type: CertificateDocumentUploadRequest })
  @ApiCreatedResponse({ type: CertificateDocumentUploaded })
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
      'certificate.not-editable, certificate.edit-withdraws-submission, document.limit-reached, ' +
      'draft-quota.exceeded, conflict.stale',
  })
  @ApiPayloadTooLargeResponse({ type: CertificationErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'file.unreadable, file.too-many-pages, file.encrypted, file.active-content, file.too-complex or file.inspection-timeout',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'file.unsupported-type',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async postDocument(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Query('withdrawPending') withdrawPending: unknown,
    @Body() body: unknown,
  ): Promise<CertificateDocumentUploaded> {
    const input = closedBody(request, jsonOf(body), ['data']);
    let outcome: CertificateDocumentUploaded | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.uploadDocument.execute(context, {
        certificateId,
        data: input.data,
        withdrawPending: withdrawFlag(withdrawPending),
      });
      outcome = result.ok ? result.value : refusal(result.error, response, context);
    }
    return this.settle('certification.own-certificate-document-upload', context, outcome);
  }

  @Get('certificates/:certificateId/documents/:documentId')
  @ReadsSession()
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', 'sandbox')
  @Header('Content-Disposition', 'attachment')
  @ApiOperation({
    summary: 'Read one of the own files',
    description:
      'Needs certification.own-certificate.view. The bytes the intake wrote, with the type found ' +
      'in the content, as an attachment.',
  })
  @ApiOkResponse({ description: 'image/jpeg, image/png or application/pdf bytes' })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
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
    const result = await this.readDocument.execute(context, { certificateId, documentId });
    const outcome = result.ok
      ? new StreamableFile(result.value.bytes, { type: result.value.contentType })
      : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-document-read', context, outcome);
  }

  @Delete('certificates/:certificateId/documents/:documentId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Take a file off the draft of an own certificate',
    description:
      'Needs certification.own-certificate.manage. A file no submission holds is deleted; one a ' +
      'submission holds only leaves the draft. While a submission is pending, removing a file ' +
      'withdraws it (withdrawPending=true required).',
  })
  @ApiHeader(CSRF)
  @ApiQuery(WITHDRAW_PENDING)
  @ApiOkResponse({ type: CertificateDocumentRemoved })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({
    type: CertificationErrorBody,
    description: 'certificate.not-found, document.not-found',
  })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'certificate.not-editable, certificate.edit-withdraws-submission, conflict.stale',
  })
  @ApiServiceUnavailableResponse({
    type: CertificationErrorBody,
    description: 'access.unavailable',
  })
  async removeOneDocument(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Param('documentId') documentId: string,
    @Query('withdrawPending') withdrawPending: unknown,
  ): Promise<CertificateDocumentRemoved> {
    const result = await this.removeDocument.execute(context, {
      certificateId,
      documentId,
      withdrawPending: withdrawFlag(withdrawPending),
    });
    const outcome = result.ok ? result.value : refusal(result.error, response, context);
    return this.settle('certification.own-certificate-document-remove', context, outcome);
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
