import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
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
  ApiServiceUnavailableResponse,
  ApiTags,
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
import { IssuerActivate } from '../application/use-cases/issuer-activate.use-case';
import { IssuerApproveReactivation } from '../application/use-cases/issuer-approve-reactivation.use-case';
import { IssuerCloseToNew } from '../application/use-cases/issuer-close-to-new.use-case';
import { IssuerCreate } from '../application/use-cases/issuer-create.use-case';
import { IssuerDerecognise } from '../application/use-cases/issuer-derecognise.use-case';
import { IssuerExpertReferenceRead } from '../application/use-cases/issuer-expert-reference-read.use-case';
import { IssuerProposalReject } from '../application/use-cases/issuer-proposal-reject.use-case';
import { IssuerProposalWithdraw } from '../application/use-cases/issuer-proposal-withdraw.use-case';
import { IssuerRead } from '../application/use-cases/issuer-read.use-case';
import { IssuerRequestReactivation } from '../application/use-cases/issuer-request-reactivation.use-case';
import { IssuersList } from '../application/use-cases/issuers-list.use-case';
import { pageQuery } from './http-answers';
import { CertificationErrorBody } from './own-certificate.dto';
import { CSRF, RegistryHttp, SECOND_ADMIN, UNAUTHORIZED } from './registry-http';
import {
  IssuerActivateRequest,
  IssuerCreateRequest,
  IssuerDerecogniseRequest,
  IssuerExpertReferenceView,
  IssuerReactivationRequest,
  IssuersListView,
  IssuerStateView,
  IssuerView,
  ProposalClosedView,
  VersionRequest,
} from './registry.dto';

const EDIT =
  'Needs certification.issuer.edit (protected: no default role holds it; the Platform ' +
  'Administrator grants it). Not in a Login as Seller session.';
const UNAVAILABLE = { type: CertificationErrorBody, description: 'access.unavailable' };
const BAD_REQUEST = { type: CertificationErrorBody, description: 'validation.failed' };
const UNSUPPORTED = { type: CertificationErrorBody, description: 'request.body-unsupported' };
const NOT_FOUND = { type: CertificationErrorBody, description: 'issuer.not-found' };
const DENIED = { type: CertificationErrorBody, description: 'access.denied, request.csrf' };

/**
 * The issuer registry admin page (certification design 3.5, 7.2; slice 12; AC 19; H1): the list,
 * one issuer, its expert reference (an audited read of its own), create, activate with an expert
 * reference, the two deactivation forms (closed-to-new, derecognised) and reactivation approved by
 * a second admin. Thin adapters over one use case each; the guard only authenticates (the admin
 * population), the permission, the second-admin rule and the not-acting-as rule are the use
 * cases'.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/issuers')
export class AdminIssuerRegistryController {
  readonly #http = new RegistryHttp('AdminIssuerRegistryController');

  constructor(
    private readonly list: IssuersList,
    private readonly read: IssuerRead,
    private readonly referenceRead: IssuerExpertReferenceRead,
    private readonly create: IssuerCreate,
    private readonly activate: IssuerActivate,
    private readonly closeToNew: IssuerCloseToNew,
    private readonly derecognise: IssuerDerecognise,
    private readonly requestReactivation: IssuerRequestReactivation,
    private readonly approveReactivation: IssuerApproveReactivation,
    private readonly reject: IssuerProposalReject,
    private readonly withdraw: IssuerProposalWithdraw,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The issuer registry of the Market',
    description:
      'Needs certification.issuer.view. Filters `typeId` and `state`; pages by `afterId` and ' +
      '`limit`. No expert reference in the list.',
  })
  @ApiOkResponse({ type: IssuersListView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getList(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<IssuersListView> {
    const outcome = this.#http.answer(
      await this.list.execute(context, pageQuery(query)),
      response,
      context,
    );
    return this.#http.settle('certification.issuers-list', context, outcome as IssuersListView);
  }

  @Get(':issuerId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'One issuer',
    description:
      'Needs certification.issuer.view. The state history fields, whether an expert reference ' +
      'is stored, the approved certificates that name the issuer now (the count the ' +
      'derecognition form confirms) and a pending reactivation without its reference.',
  })
  @ApiOkResponse({ type: IssuerView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
  ): Promise<IssuerView> {
    const outcome = this.#http.answer(
      await this.read.execute(context, { issuerId }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.issuer-read',
      context,
      outcome as unknown as IssuerView,
    );
  }

  @Get(':issuerId/expert-reference')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The expert approval reference of an issuer',
    description:
      `${EDIT} The reference in force and that of a pending reactivation, decrypted, shown as ` +
      'plain text. Each read is audited.',
  })
  @ApiOkResponse({ type: IssuerExpertReferenceView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getExpertReference(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
  ): Promise<IssuerExpertReferenceView> {
    const outcome = this.#http.answer(
      await this.referenceRead.execute(context, { issuerId }),
      response,
      context,
    );
    return this.#http.settle('certification.issuer-expert-reference-read', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add an issuer to the registry',
    description:
      `${EDIT} The issuer starts proposed, under a type of the Market; its name and ` +
      'accreditation number are unique within the type.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerCreateRequest })
  @ApiCreatedResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(DENIED)
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'issuer.name-taken, issuer.accreditation-taken',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postCreate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-create',
      context,
      request,
      response,
      body,
      { required: ['typeId', 'displayName'], optional: ['accreditationNumber'] },
      (input) =>
        this.create.execute(context, {
          typeId: input.typeId,
          displayName: input.displayName,
          accreditationNumber: input.accreditationNumber,
        }),
    );
  }

  @Post(':issuerId/activate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Activate a proposed issuer',
    description: `${EDIT} Under the issuer version read, with an expert approval reference (AC 19).`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerActivateRequest })
  @ApiOkResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(DENIED)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, issuer.transition-forbidden',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'issuer.expert-approval-required',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postActivate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-activate',
      context,
      request,
      response,
      body,
      { required: ['version', 'expertApproval'] },
      (input) =>
        this.activate.execute(context, {
          issuerId,
          version: input.version,
          expertApproval: input.expertApproval,
        }),
    );
  }

  @Post(':issuerId/close-to-new')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Deactivation form 1: close an issuer to new certificates',
    description:
      `${EDIT} Under the issuer version read. Existing certificates stay valid to their expiry; ` +
      'new submissions naming it are refused. Publishes certification.issuer-deactivated.v1 ' +
      '(form closed-to-new).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(DENIED)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, issuer.transition-forbidden',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postCloseToNew(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-close-to-new',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) => this.closeToNew.execute(context, { issuerId, version: input.version }),
    );
  }

  @Post(':issuerId/derecognise')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Deactivation form 2: derecognise an issuer',
    description:
      `${EDIT} Under the issuer version read, confirming the number of approved certificates ` +
      'the form showed (issuer.confirmation-count-mismatch if it changed). Terminal: the ' +
      'certificates stop counting as certified. Each affected seller Owner gets a mail; ' +
      'publishes certification.issuer-deactivated.v1 (form derecognised).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerDerecogniseRequest })
  @ApiOkResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(DENIED)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, issuer.transition-forbidden, issuer.confirmation-count-mismatch',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postDerecognise(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-derecognise',
      context,
      request,
      response,
      body,
      { required: ['version', 'affectedCertificates'] },
      (input) =>
        this.derecognise.execute(context, {
          issuerId,
          version: input.version,
          affectedCertificates: input.affectedCertificates,
        }),
    );
  }

  @Post(':issuerId/reactivation')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask for the reactivation of a closed-to-new issuer',
    description:
      `${EDIT} Under the issuer version read, with a new expert approval reference. The ` +
      'issuer stays closed-to-new until a second admin with certification.issuer.edit, not ' +
      'the requester, approves it. A derecognised issuer is terminal.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: IssuerReactivationRequest })
  @ApiOkResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse(DENIED)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, issuer.transition-forbidden, review.proposal-pending',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'issuer.expert-approval-required, issuer.expert-approval-not-new',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postReactivation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-request-reactivation',
      context,
      request,
      response,
      body,
      { required: ['version', 'expertApproval'], optional: ['reason'] },
      (input) =>
        this.requestReactivation.execute(context, {
          issuerId,
          version: input.version,
          expertApproval: input.expertApproval,
          reason: input.reason,
        }),
    );
  }

  @Post(':issuerId/reactivations/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve the reactivation of an issuer as the second admin',
    description:
      `${EDIT} Under the proposal version read; the requester may not approve. The issuer is ` +
      'active again under the new expert reference.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: IssuerStateView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: SECOND_ADMIN })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'proposal.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-closed, issuer.transition-forbidden',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postApproveReactivation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<IssuerStateView> {
    return this.#http.post(
      'certification.issuer-approve-reactivation',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.approveReactivation.execute(context, { issuerId, proposalId, version: input.version }),
    );
  }

  @Post(':issuerId/proposals/:proposalId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a pending issuer reactivation',
    description: `${EDIT} Under the proposal version read; another admin than the requester.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: ProposalClosedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: SECOND_ADMIN })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'proposal.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-closed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postReject(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalClosedView> {
    return this.#http.post(
      'certification.issuer-proposal-reject',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.reject.execute(context, { subjectId: issuerId, proposalId, version: input.version }),
    );
  }

  @Post(':issuerId/proposals/:proposalId/withdraw')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Withdraw your own pending issuer reactivation',
    description: `${EDIT} Under the proposal version read; only the requester.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: ProposalClosedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: SECOND_ADMIN })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'proposal.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-closed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postWithdraw(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('issuerId') issuerId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalClosedView> {
    return this.#http.post(
      'certification.issuer-proposal-withdraw',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.withdraw.execute(context, { subjectId: issuerId, proposalId, version: input.version }),
    );
  }
}
