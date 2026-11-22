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
import { TypeApproveCreation } from '../application/use-cases/type-approve-creation.use-case';
import { TypeApproveReactivation } from '../application/use-cases/type-approve-reactivation.use-case';
import { TypeApproveRelaxation } from '../application/use-cases/type-approve-relaxation.use-case';
import { TypeCreate } from '../application/use-cases/type-create.use-case';
import { TypeDeactivate } from '../application/use-cases/type-deactivate.use-case';
import { TypeNewOptions } from '../application/use-cases/type-new-options.use-case';
import { TypeProposalReject } from '../application/use-cases/type-proposal-reject.use-case';
import { TypeProposalWithdraw } from '../application/use-cases/type-proposal-withdraw.use-case';
import { TypeRead } from '../application/use-cases/type-read.use-case';
import { TypeRequestReactivation } from '../application/use-cases/type-request-reactivation.use-case';
import { TypeSaveRevision } from '../application/use-cases/type-save-revision.use-case';
import { TypesList } from '../application/use-cases/types-list.use-case';
import { CertificationErrorBody } from './own-certificate.dto';
import { CSRF, RegistryHttp, SECOND_ADMIN, UNAUTHORIZED } from './registry-http';
import {
  ProposalClosedView,
  ReasonedVersionRequest,
  TypeCreatedView,
  TypeCreateRequest,
  TypeNewOptionsView,
  TypeRelaxationApprovedView,
  TypeRevisionRequest,
  TypeRevisionSavedView,
  TypesListView,
  TypeStatusView,
  TypeView,
  VersionRequest,
} from './registry.dto';

const EDIT =
  'Needs certification.type.edit (protected: no default role holds it; the Platform ' +
  'Administrator grants it). Not in a Login as Seller session.';
const UNAVAILABLE = { type: CertificationErrorBody, description: 'access.unavailable' };
const BAD_REQUEST = { type: CertificationErrorBody, description: 'validation.failed' };
const UNSUPPORTED = { type: CertificationErrorBody, description: 'request.body-unsupported' };

/**
 * The certification type admin page (certification design 3.6, 7.1, 7.6; slice 12; H1): the
 * list, one type with its published revision and pending proposals, a save, deactivation, and
 * reactivation and relaxation approved by a second admin. Thin adapters over one use case each;
 * the guard only authenticates (the admin population), the permission, the second-admin rule
 * and the not-acting-as rule are the use cases'.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/types')
export class AdminCertificationTypeController {
  readonly #http = new RegistryHttp('AdminCertificationTypeController');

  constructor(
    private readonly list: TypesList,
    private readonly read: TypeRead,
    private readonly save: TypeSaveRevision,
    private readonly deactivate: TypeDeactivate,
    private readonly requestReactivation: TypeRequestReactivation,
    private readonly approveRelaxation: TypeApproveRelaxation,
    private readonly approveReactivation: TypeApproveReactivation,
    private readonly reject: TypeProposalReject,
    private readonly withdraw: TypeProposalWithdraw,
    private readonly create: TypeCreate,
    private readonly approveCreation: TypeApproveCreation,
    private readonly newOptions: TypeNewOptions,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The certification types of the Market',
    description:
      'Needs certification.type.view. Every type by code: active, inactive and proposed; ' +
      'rejected and withdrawn proposals of new types only with `closed=true`.',
  })
  @ApiOkResponse({ type: TypesListView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getList(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query('closed') closed?: string,
  ): Promise<TypesListView> {
    const outcome = this.#http.answer(
      await this.list.execute(context, {
        closed: closed === undefined ? false : closed === 'true' ? true : closed,
      }),
      response,
      context,
    );
    return this.#http.settle('certification.types-list', context, outcome as TypesListView);
  }

  // Declared before `:typeId`, so `new-options` is never read as a type id.
  @Get('new-options')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'What the New type form offers',
    description:
      `${EDIT} The Market's locales, the verification modes and default bases, the badge ` +
      'artwork that exists, and the length limits.',
  })
  @ApiOkResponse({ type: TypeNewOptionsView })
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  async getNewOptions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TypeNewOptionsView> {
    const outcome = this.#http.answer(
      await this.newOptions.execute(context, {}),
      response,
      context,
    );
    return this.#http.settle('certification.type-new-options', context, outcome);
  }

  @Post()
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Propose a new certification type',
    description:
      `${EDIT} The type is created proposed with its first revision: sellers and customers ` +
      'do not see it and its claim terms are not matched until another admin with ' +
      'certification.type.edit approves it. The code is never a seed code of the Market and ' +
      'is never reused.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: TypeCreateRequest })
  @ApiCreatedResponse({ type: TypeCreatedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'type.code-taken, type.code-reserved',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'type.revision-invalid (details.issues)',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postCreate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<TypeCreatedView> {
    return this.#http.post(
      'certification.type-create',
      context,
      request,
      response,
      body,
      { required: ['code', 'content'], optional: ['reason'] },
      (input) =>
        this.create.execute(context, {
          code: input.code,
          content: input.content,
          reason: input.reason,
        }),
    );
  }

  @Get(':typeId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'One certification type',
    description:
      'Needs certification.type.view. The published revision with its change reason, and a ' +
      'pending revision or reactivation with who asked, what relaxes and the allowed actions.',
  })
  @ApiOkResponse({ type: TypeView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
  ): Promise<TypeView> {
    const outcome = this.#http.answer(
      await this.read.execute(context, { typeId }),
      response,
      context,
    );
    return this.#http.settle('certification.type-read', context, outcome as unknown as TypeView);
  }

  @Post(':typeId/revisions')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save a new revision of a type',
    description:
      `${EDIT} Under the type version read. A revision that only tightens is published at ` +
      'once; one that relaxes a setting or removes a claim term waits pending until a second ' +
      'admin approves it. verificationMode never changes. A published revision opens a review ' +
      'in Admin Inbox › System requests while the Market reviews area certification (then ' +
      '`note` is required; 400 on note without it); a reviewer who rejects it restores the ' +
      'content before only when that relaxes nothing. A proposed new type is changed only by ' +
      'its proposer: the new revision replaces the proposal (outcome proposal-revised), so an ' +
      'approval of the earlier one is stale. A rejected or withdrawn type is read-only.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: TypeRevisionRequest })
  @ApiOkResponse({ type: TypeRevisionSavedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description:
      'conflict.stale, review.proposal-pending, type.revision-unchanged, type.proposal-closed',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'type.revision-invalid (details.issues)',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postRevision(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Body() body: unknown,
  ): Promise<TypeRevisionSavedView> {
    return this.#http.post(
      'certification.type-save-revision',
      context,
      request,
      response,
      body,
      { required: ['version', 'content'], optional: ['reason', 'note'] },
      (input) =>
        this.save.execute(context, {
          typeId,
          version: input.version,
          content: input.content,
          reason: input.reason,
          note: input.note,
        }),
    ) as Promise<TypeRevisionSavedView>;
  }

  @Post(':typeId/deactivate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Deactivate a type',
    description:
      `${EDIT} Under the type version read. New certificates of the type are refused; ` +
      'approved ones and renewals continue. Publishes certification-type-deactivated.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: TypeStatusView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, type.already-inactive',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postDeactivate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Body() body: unknown,
  ): Promise<TypeStatusView> {
    return this.#http.post(
      'certification.type-deactivate',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) => this.deactivate.execute(context, { typeId, version: input.version }),
    );
  }

  @Post(':typeId/reactivation')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Ask for the reactivation of an inactive type',
    description:
      `${EDIT} Under the type version read. The type stays inactive until a second admin ` +
      'with certification.type.edit, not the requester, approves it.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ReasonedVersionRequest })
  @ApiOkResponse({ type: TypeStatusView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, type.already-active, review.proposal-pending',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postReactivation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Body() body: unknown,
  ): Promise<TypeStatusView> {
    return this.#http.post(
      'certification.type-request-reactivation',
      context,
      request,
      response,
      body,
      { required: ['version'], optional: ['reason'] },
      (input) =>
        this.requestReactivation.execute(context, {
          typeId,
          version: input.version,
          reason: input.reason,
        }),
    );
  }

  @Post(':typeId/relaxations/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a relaxing revision as the second admin',
    description:
      `${EDIT} Under the proposal version read; the requester may not approve. Publishes the ` +
      'pending revision.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: TypeRelaxationApprovedView })
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
  postApproveRelaxation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<TypeRelaxationApprovedView> {
    return this.#http.post(
      'certification.type-approve-relaxation',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.approveRelaxation.execute(context, { typeId, proposalId, version: input.version }),
    );
  }

  @Post(':typeId/reactivations/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve the reactivation of a type as the second admin',
    description:
      `${EDIT} Under the proposal version read; the requester may not approve. The type is ` +
      'active again; publishes certification-type-activated.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: TypeStatusView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: SECOND_ADMIN })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'proposal.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-closed, type.already-active',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postApproveReactivation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<TypeStatusView> {
    return this.#http.post(
      'certification.type-approve-reactivation',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.approveReactivation.execute(context, { typeId, proposalId, version: input.version }),
    );
  }

  @Post(':typeId/creations/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a proposed new type as the second admin',
    description:
      `${EDIT} Under the proposal version read; the proposer may not approve. A proposal the ` +
      'proposer has since changed is stale. The type becomes active and its claim terms are ' +
      'matched from now on; publishes certification-type-activated.v1.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: TypeStatusView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: SECOND_ADMIN })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'proposal.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-closed, type.not-proposed, type.proposal-closed',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postApproveCreation(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<TypeStatusView> {
    return this.#http.post(
      'certification.type-approve-creation',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.approveCreation.execute(context, { typeId, proposalId, version: input.version }),
    );
  }

  @Post(':typeId/proposals/:proposalId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a pending type proposal',
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
    @Param('typeId') typeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalClosedView> {
    return this.#http.post(
      'certification.type-proposal-reject',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.reject.execute(context, { subjectId: typeId, proposalId, version: input.version }),
    );
  }

  @Post(':typeId/proposals/:proposalId/withdraw')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Withdraw your own pending type proposal',
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
    @Param('typeId') typeId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
  ): Promise<ProposalClosedView> {
    return this.#http.post(
      'certification.type-proposal-withdraw',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.withdraw.execute(context, { subjectId: typeId, proposalId, version: input.version }),
    );
  }
}
