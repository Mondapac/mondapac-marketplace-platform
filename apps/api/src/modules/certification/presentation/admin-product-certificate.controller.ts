import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ProductCertificateApprove } from '../application/use-cases/product-certificate-approve.use-case';
import { ProductCertificateCreate } from '../application/use-cases/product-certificate-create.use-case';
import { ProductCertificateRead } from '../application/use-cases/product-certificate-read.use-case';
import { ProductCertificateReject } from '../application/use-cases/product-certificate-reject.use-case';
import { ProductCertificateReviewRead } from '../application/use-cases/product-certificate-review-read.use-case';
import { ProductCertificateSaveDraft } from '../application/use-cases/product-certificate-save-draft.use-case';
import { ProductCertificateSubmit } from '../application/use-cases/product-certificate-submit.use-case';
import { ProductCertificatesList } from '../application/use-cases/product-certificates-list.use-case';
import { ProductCertificateHistoryRead } from '../application/use-cases/product-certificate-history-read.use-case';
import { ProductCertificateReinstate } from '../application/use-cases/product-certificate-reinstate.use-case';
import { ProductCertificateRevoke } from '../application/use-cases/product-certificate-revoke.use-case';
import { ProductCertificateSuspend } from '../application/use-cases/product-certificate-suspend.use-case';
import { ProductCertificateRecordCheck } from '../application/use-cases/product-certificate-record-check.use-case';
import { ProductCertificateRemoveDocument } from '../application/use-cases/product-certificate-remove-document.use-case';
import { ProductCertificateUploadDocument } from '../application/use-cases/product-certificate-upload-document.use-case';
import { CertificationErrorBody } from './own-certificate.dto';
import {
  ProductCertificateCreatedView,
  ProductCertificateCreateRequest,
  ProductCertificateDraftRequest,
  ProductCertificateListView,
  ProductCertificateReviewView,
  ProductCertificateView,
  ProductCheckRecordedView,
  ProductCheckRequest,
  ProductDecidedView,
  ProductDecisionRequest,
  ProductDocumentRemovedView,
  ProductDocumentUploadedView,
  ProductDocumentUploadRequest,
  ProductDraftSavedView,
  ProductEndedView,
  ProductEndRequest,
  ProductHistoryView,
  ProductReinstatedView,
  ProductReinstateRequest,
  ProductRejectRequest,
  ProductSubmitRequest,
  ProductSubmittedView,
} from './product-certificate.dto';
import { CSRF, RegistryHttp, UNAUTHORIZED } from './registry-http';

/**
 * The HTTP status of each refusal of the manufacturer certificate routes (slice 14): a malformed
 * request 400; a decider who created or edited the revision 403; an unknown record or type 404;
 * a moved record, a draft that may not be edited, a revision that is no longer pending, a
 * closed record and a lifecycle step from the wrong status (slice 15) 409; a submission, approval
 * or reinstatement the rules refuse 422. The files (slice 15 part 2): an unknown file 404, a full
 * draft 409, the intake's refusals as on the seller route (413, 415, 422) and a full intake
 * queue 429.
 */
export const PRODUCT_CERTIFICATE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'approval.same-admin': 403,
  'certificate.not-found': 404,
  'type.not-found': 404,
  'conflict.stale': 409,
  'certificate.not-editable': 409,
  'certificate.closed': 409,
  'certificate.suspended': 409,
  'certificate.not-suspendable': 409,
  'certificate.not-suspended': 409,
  'certificate.revoked': 409,
  'certificate.not-revocable': 409,
  'review.not-current-revision': 409,
  'document.not-found': 404,
  'document.limit-reached': 409,
  'file.too-large': 413,
  'file.unsupported-type': 415,
  'file.unreadable': 422,
  'file.too-many-pages': 422,
  'file.encrypted': 422,
  'file.active-content': 422,
  'file.too-complex': 422,
  'file.inspection-timeout': 422,
  'request.throttled': 429,
  'review.checks-incomplete': 422,
  'certificate.incomplete': 422,
  'certificate.expired': 422,
  'issuer.not-active': 422,
  'type.inactive': 422,
  'type.manufacturer-basis-not-allowed': 422,
});

const EDIT =
  'Needs certification.product-certificate.edit (protected: no default role holds it; the ' +
  'Platform Administrator grants it). Not in a Login as Seller session.';
const APPROVE =
  'Needs certification.product-certificate.approve (protected). Another person: not the ' +
  "record's creator, nor any admin who edited the draft of the revision or submitted it. Not in " +
  'a Login as Seller session.';
const REVOKE =
  'Needs certification.product-certificate.revoke (protected: no default role holds it; the ' +
  'Platform Administrator grants it). Not in a Login as Seller session.';
const UNAVAILABLE = { type: CertificationErrorBody, description: 'access.unavailable' };
const BAD_REQUEST = { type: CertificationErrorBody, description: 'validation.failed' };
const UNSUPPORTED = { type: CertificationErrorBody, description: 'request.body-unsupported' };
const FORBIDDEN = { type: CertificationErrorBody, description: 'access.denied, request.csrf' };
const NOT_FOUND = { type: CertificationErrorBody, description: 'certificate.not-found' };

/**
 * The file upload arrives as bytes (its body parser takes a larger limit than the JSON one, as the
 * seller's); anything that is not a JSON object stays as it is and `closedBody` refuses it.
 */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** A whole number of a query string, or -1 (refused by the use case). */
function numberParam(value: unknown): unknown {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : -1;
}

/**
 * The manufacturer certificate admin pages (certification design 3.4, 7.1, 7.2; ADR-0012 d3;
 * CERT-41; AC 20; slice 14): list, read, the review read with the number, create, save the draft
 * with its coverage, submit, and approve or reject by another person; from slice 15 the status
 * history, suspend and revoke, and reinstate by another person. Thin adapters over one use
 * case each; the guard only authenticates (the admin population); the permission, the
 * other-person rule and the not-acting-as rule are the use cases'. From slice 15 part 2 the
 * draft's files (upload, remove; reviewer download stays off) and the reviewer's checks.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/product-certificates')
export class AdminProductCertificateController {
  readonly #http = new RegistryHttp(
    'AdminProductCertificateController',
    PRODUCT_CERTIFICATE_STATUS,
  );

  constructor(
    private readonly list: ProductCertificatesList,
    private readonly read: ProductCertificateRead,
    private readonly reviewRead: ProductCertificateReviewRead,
    private readonly create: ProductCertificateCreate,
    private readonly saveDraft: ProductCertificateSaveDraft,
    private readonly submit: ProductCertificateSubmit,
    private readonly approve: ProductCertificateApprove,
    private readonly reject: ProductCertificateReject,
    private readonly suspend: ProductCertificateSuspend,
    private readonly revoke: ProductCertificateRevoke,
    private readonly reinstate: ProductCertificateReinstate,
    private readonly historyRead: ProductCertificateHistoryRead,
    private readonly uploadDocument: ProductCertificateUploadDocument,
    private readonly removeDocument: ProductCertificateRemoveDocument,
    private readonly recordCheck: ProductCertificateRecordCheck,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The manufacturer certificates of the Market',
    description:
      'Needs certification.product-certificate.view. Newest first; filters by status and type. ' +
      'Clear fields only, never the number.',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'typeId', required: false })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100, default 50' })
  @ApiQuery({ name: 'offset', required: false, description: '0 to 10000, default 0' })
  @ApiOkResponse({ type: ProductCertificateListView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getList(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductCertificateListView> {
    const outcome = this.#http.answer(
      await this.list.execute(context, {
        status: query['status'],
        typeId: query['typeId'],
        limit: numberParam(query['limit']),
        offset: numberParam(query['offset']),
      }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.product-certificates-list',
      context,
      outcome as unknown as ProductCertificateListView,
    );
  }

  @Get(':certificateId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'One manufacturer certificate',
    description:
      'Needs certification.product-certificate.view. The draft, the pending and approved ' +
      'revisions with coverage, editors and decisions; never the number.',
  })
  @ApiOkResponse({ type: ProductCertificateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<ProductCertificateView> {
    const outcome = this.#http.answer(
      await this.read.execute(context, { certificateId }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.product-certificate-read',
      context,
      outcome as unknown as ProductCertificateView,
    );
  }

  @Get(':certificateId/review')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'One manufacturer certificate with its numbers, for the approver',
    description:
      'Needs certification.product-certificate.approve (protected). As the read, with the ' +
      "certificate number of the draft and of each revision decrypted, and the Market's " +
      'review checks (which are required). Not in a Login as Seller session.',
  })
  @ApiOkResponse({ type: ProductCertificateReviewView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getReview(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<ProductCertificateReviewView> {
    const outcome = this.#http.answer(
      await this.reviewRead.execute(context, { certificateId }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.product-certificate-review-read',
      context,
      outcome as unknown as ProductCertificateReviewView,
    );
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record a manufacturer certificate (an empty draft)',
    description: `${EDIT} The type must be active and a third-party document type.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductCertificateCreateRequest })
  @ApiCreatedResponse({ type: ProductCertificateCreatedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'type.inactive, type.manufacturer-basis-not-allowed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postCreate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<ProductCertificateCreatedView> {
    return this.#http.post(
      'certification.product-certificate-create',
      context,
      request,
      response,
      body,
      { required: ['typeId'] },
      (input) => this.create.execute(context, { typeId: input.typeId }),
    );
  }

  @Put(':certificateId/draft')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save the draft of a manufacturer certificate with its coverage',
    description:
      `${EDIT} Under the record version read; the whole draft. Every covered product must be ` +
      'published in the Market and is recorded at its current published revision; a narrowed ' +
      'entry names variants of that revision. Refused while a revision is pending. The saving ' +
      'admin may not approve the revision this draft becomes.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductCertificateDraftRequest })
  @ApiOkResponse({ type: ProductDraftSavedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.not-editable',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  putDraft(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductDraftSavedView> {
    return this.#http.post(
      'certification.product-certificate-save-draft',
      context,
      request,
      response,
      body,
      {
        required: [
          'version',
          'manufacturerName',
          'issuerId',
          'issueDate',
          'expiryDate',
          'coverage',
        ],
        optional: ['certificateNumber'],
      },
      (input) => {
        const { version, ...draft } = input;
        return this.saveDraft.execute(context, { certificateId, version, draft });
      },
    );
  }

  @Post(':certificateId/submit')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Submit the draft as a new pending revision',
    description:
      `${EDIT} Under the record version read. A complete draft (manufacturer, issuer, number, ` +
      'the expiry date and a document where the type requires them, coverage), the issuer ' +
      'active, the expiry not passed in the Market zone, and every covered product still at the ' +
      "recorded published revision. The draft's files are sealed into the revision.",
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductSubmitRequest })
  @ApiOkResponse({ type: ProductSubmittedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.not-editable',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'certificate.incomplete (details.fields), issuer.not-active, type.inactive, ' +
      'certificate.expired, type.manufacturer-basis-not-allowed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postSubmit(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductSubmittedView> {
    return this.#http.post(
      'certification.product-certificate-submit',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) => this.submit.execute(context, { certificateId, version: input.version }),
    );
  }

  @Post(':certificateId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve the pending revision',
    description:
      `${APPROVE} Under the record version read, naming the pending revision. The issuer ` +
      'active, the type active for a record never approved, the expiry boundary in the Market ' +
      'zone after now; a document where the type requires one; every required check of the ' +
      "Market's list recorded by another person as done or not applicable. Publishes " +
      'product-certification-approved.v1, or -coverage-changed.v1 when it replaces an approved ' +
      'revision of other coverage.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductDecisionRequest })
  @ApiOkResponse({ type: ProductDecidedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'approval.same-admin, access.denied, request.csrf',
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description:
      'conflict.stale, review.not-current-revision, certificate.closed, certificate.suspended',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'issuer.not-active, type.inactive, certificate.expired, certificate.incomplete, ' +
      'review.checks-incomplete (details.fields)',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postApprove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductDecidedView> {
    return this.#http.post(
      'certification.product-certificate-approve',
      context,
      request,
      response,
      body,
      { required: ['version', 'revisionId'] },
      (input) =>
        this.approve.execute(context, {
          certificateId,
          revisionId: input.revisionId,
          version: input.version,
        }),
    );
  }

  @Post(':certificateId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject the pending revision',
    description:
      `${APPROVE} Under the record version read, naming the pending revision, with a reason ` +
      "code of the Market's list. A record never approved ends rejected; an approved one keeps " +
      'its approved revision.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductRejectRequest })
  @ApiOkResponse({ type: ProductDecidedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'approval.same-admin, access.denied, request.csrf',
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.not-current-revision',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postReject(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductDecidedView> {
    return this.#http.post(
      'certification.product-certificate-reject',
      context,
      request,
      response,
      body,
      { required: ['version', 'revisionId', 'reasonCode'] },
      (input) =>
        this.reject.execute(context, {
          certificateId,
          revisionId: input.revisionId,
          version: input.version,
          reasonCode: input.reasonCode,
        }),
    );
  }

  @Get(':certificateId/history')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The status history of a manufacturer certificate',
    description:
      'Needs certification.product-certificate.view. Newest first, at most 200 rows: from, to, ' +
      'the revision, the admin or the system, the reason code and whether a note was given; ' +
      'never the note.',
  })
  @ApiOkResponse({ type: ProductHistoryView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getHistory(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
  ): Promise<ProductHistoryView> {
    const outcome = this.#http.answer(
      await this.historyRead.execute(context, { certificateId }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.product-certificate-history-read',
      context,
      outcome as unknown as ProductHistoryView,
    );
  }

  @Post(':certificateId/suspend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Suspend an approved manufacturer certificate',
    description:
      `${REVOKE} Under the record version read, with a reason code of the Market's list for ` +
      'the suspended outcome and an optional note. The claim stops at once; publishes ' +
      'product-certification-suspended.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductEndRequest })
  @ApiOkResponse({ type: ProductEndedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description:
      'conflict.stale, certificate.suspended, certificate.not-suspendable, certificate.closed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postSuspend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductEndedView> {
    return this.#http.post(
      'certification.product-certificate-suspend',
      context,
      request,
      response,
      body,
      { required: ['version', 'reasonCode'], optional: ['reasonText'] },
      (input) =>
        this.suspend.execute(context, {
          certificateId,
          version: input.version,
          reasonCode: input.reasonCode,
          reasonText: input.reasonText,
        }),
    );
  }

  @Post(':certificateId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Revoke an approved or suspended manufacturer certificate',
    description:
      `${REVOKE} Under the record version read, with a reason code of the Market's list for ` +
      'the revoked outcome and an optional note. Terminal; a pending revision is withdrawn. The ' +
      'claim stops at once; publishes product-certification-revoked.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductEndRequest })
  @ApiOkResponse({ type: ProductEndedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.revoked, certificate.not-revocable',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postRevoke(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductEndedView> {
    return this.#http.post(
      'certification.product-certificate-revoke',
      context,
      request,
      response,
      body,
      { required: ['version', 'reasonCode'], optional: ['reasonText'] },
      (input) =>
        this.revoke.execute(context, {
          certificateId,
          version: input.version,
          reasonCode: input.reasonCode,
          reasonText: input.reasonText,
        }),
    );
  }

  @Post(':certificateId/reinstate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reinstate a suspended manufacturer certificate on its approved revision',
    description:
      'Needs certification.product-certificate.approve (protected). Another person: not the ' +
      "record's creator, nor any admin who edited or submitted the approved revision. Not in a " +
      'Login as Seller session. Under the record version read; the issuer still counts and the ' +
      'expiry boundary in the Market zone is ahead. Publishes product-certification-approved.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductReinstateRequest })
  @ApiOkResponse({ type: ProductReinstatedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'approval.same-admin, access.denied, request.csrf',
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.not-suspended, certificate.closed',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'issuer.not-active, certificate.expired',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postReinstate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductReinstatedView> {
    return this.#http.post(
      'certification.product-certificate-reinstate',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) => this.reinstate.execute(context, { certificateId, version: input.version }),
    );
  }

  @Post(':certificateId/documents')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a file to the draft of a manufacturer certificate',
    description:
      `${EDIT} Under the record version read; the draft open for edit (no pending revision). ` +
      'At most 10 MiB and 10 files a draft. The type comes from the content (JPEG, PNG, PDF); ' +
      'images are written again without metadata; a PDF with encryption or active content is ' +
      "refused. Stored encrypted under the Market's platform key. The uploading admin may not " +
      'approve the revision this draft becomes.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductDocumentUploadRequest })
  @ApiCreatedResponse({ type: ProductDocumentUploadedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.not-editable, document.limit-reached',
  })
  @ApiPayloadTooLargeResponse({ type: CertificationErrorBody, description: 'file.too-large' })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description:
      'file.unreadable, file.too-many-pages, file.encrypted, file.active-content, ' +
      'file.too-complex or file.inspection-timeout',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: CertificationErrorBody,
    description: 'file.unsupported-type, request.body-unsupported',
  })
  @ApiTooManyRequestsResponse({ type: CertificationErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postDocument(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductDocumentUploadedView> {
    return this.#http.post(
      'certification.product-certificate-upload-document',
      context,
      request,
      response,
      jsonOf(body),
      { required: ['version', 'data'] },
      (input) =>
        this.uploadDocument.execute(context, {
          certificateId,
          version: input.version,
          data: input.data,
        }),
    );
  }

  @Delete(':certificateId/documents/:documentId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Take a file off the draft of a manufacturer certificate',
    description:
      `${EDIT} Under the record version read (query version); the draft open for edit. A file ` +
      'no revision holds is deleted; one a revision holds only leaves the draft.',
  })
  @ApiHeader(CSRF)
  @ApiQuery({ name: 'version', required: true, description: 'The record version as it was read.' })
  @ApiOkResponse({ type: ProductDocumentRemovedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    type: CertificationErrorBody,
    description: 'certificate.not-found, document.not-found',
  })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, certificate.not-editable',
  })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async deleteDocument(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Param('documentId') documentId: string,
    @Query('version') version: unknown,
  ): Promise<ProductDocumentRemovedView> {
    const outcome = this.#http.answer(
      await this.removeDocument.execute(context, {
        certificateId,
        documentId,
        version: numberParam(version),
      }),
      response,
      context,
    );
    return this.#http.settle('certification.product-certificate-remove-document', context, outcome);
  }

  @Post(':certificateId/checks')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Record the result of one review check of the pending revision',
    description:
      `${APPROVE} Under the record version read, naming the pending revision and a check code ` +
      "of the Market's list for a third-party document type. A new result for the same code " +
      'adds a row; the latest counts.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ProductCheckRequest })
  @ApiCreatedResponse({ type: ProductCheckRecordedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'approval.same-admin, access.denied, request.csrf',
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.not-current-revision',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postCheck(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('certificateId') certificateId: string,
    @Body() body: unknown,
  ): Promise<ProductCheckRecordedView> {
    return this.#http.post(
      'certification.product-certificate-record-check',
      context,
      request,
      response,
      body,
      { required: ['version', 'revisionId', 'checkCode', 'result'] },
      (input) =>
        this.recordCheck.execute(context, {
          certificateId,
          revisionId: input.revisionId,
          version: input.version,
          checkCode: input.checkCode,
          result: input.result,
        }),
    );
  }
}
