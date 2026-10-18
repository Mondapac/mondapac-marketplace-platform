import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ClaimPolicyApproveRelaxation } from '../application/use-cases/claim-policy-approve-relaxation.use-case';
import { ClaimPolicyProposalReject } from '../application/use-cases/claim-policy-proposal-reject.use-case';
import { ClaimPolicyProposalWithdraw } from '../application/use-cases/claim-policy-proposal-withdraw.use-case';
import { ClaimPolicyRead } from '../application/use-cases/claim-policy-read.use-case';
import { ClaimPolicySaveRevision } from '../application/use-cases/claim-policy-save-revision.use-case';
import { CertificationErrorBody } from './own-certificate.dto';
import { CSRF, RegistryHttp, SECOND_ADMIN, UNAUTHORIZED } from './registry-http';
import {
  ClaimPolicyRelaxationApprovedView,
  ClaimPolicyRevisionRequest,
  ClaimPolicyRevisionSavedView,
  ClaimPolicyView,
  ProposalClosedView,
  VersionRequest,
} from './registry.dto';

const EDIT =
  'Needs certification.claim-policy.edit (protected: no default role holds it; the Platform ' +
  'Administrator grants it). Not in a Login as Seller session.';
const UNAVAILABLE = { type: CertificationErrorBody, description: 'access.unavailable' };
const BAD_REQUEST = { type: CertificationErrorBody, description: 'validation.failed' };
const UNSUPPORTED = { type: CertificationErrorBody, description: 'request.body-unsupported' };

/**
 * The claim basis policy admin page (certification design 3.7, 7.1, 7.6; CERT-42; slice 13; H1):
 * one type's policy with its published rows, history and pending relaxation, a save, and the
 * relaxation approved by a second admin, rejected or withdrawn. Addressed by the type (one policy
 * per Market and type). Thin adapters over one use case each; the guard only authenticates (the
 * admin population); the permission, the second-admin rule and the not-acting-as rule are the
 * use cases'.
 */
@ApiTags('certification')
@RoutePopulation('admin')
@Controller('certification/admin/claim-policies')
export class AdminClaimPolicyController {
  readonly #http = new RegistryHttp('AdminClaimPolicyController');

  constructor(
    private readonly read: ClaimPolicyRead,
    private readonly save: ClaimPolicySaveRevision,
    private readonly approveRelaxation: ClaimPolicyApproveRelaxation,
    private readonly reject: ClaimPolicyProposalReject,
    private readonly withdraw: ClaimPolicyProposalWithdraw,
  ) {}

  @Get(':typeId')
  @Header('Cache-Control', 'private, no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'The claim basis policy of a certification type',
    description:
      'Needs certification.claim-policy.view. The published rows with the change reason, the ' +
      "type's default basis, a pending relaxation with what relaxes and the allowed actions, " +
      'and the revision history.',
  })
  @ApiOkResponse({ type: ClaimPolicyView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: CertificationErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  async getOne(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
  ): Promise<ClaimPolicyView> {
    const outcome = this.#http.answer(
      await this.read.execute(context, { typeId }),
      response,
      context,
    );
    return this.#http.settle(
      'certification.claim-policy-read',
      context,
      outcome as unknown as ClaimPolicyView,
    );
  }

  @Post(':typeId/revisions')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save a new revision of the claim basis policy of a type',
    description:
      `${EDIT} Under the policy version read (0 before the first save). The whole row set; at ` +
      'most one row per selector; SELLER_OR_MANUFACTURER only on a platform category. A ' +
      'revision that only tightens is published at once (claim-policy-changed.v1); one that ' +
      'relaxes waits pending until a second admin approves it.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ClaimPolicyRevisionRequest })
  @ApiOkResponse({ type: ClaimPolicyRevisionSavedView })
  @ApiBadRequestResponse(BAD_REQUEST)
  @ApiUnauthorizedResponse({ type: CertificationErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: CertificationErrorBody,
    description: 'access.denied, request.csrf',
  })
  @ApiNotFoundResponse({ type: CertificationErrorBody, description: 'type.not-found' })
  @ApiConflictResponse({
    type: CertificationErrorBody,
    description: 'conflict.stale, review.proposal-pending, claim-policy.revision-unchanged',
  })
  @ApiUnprocessableEntityResponse({
    type: CertificationErrorBody,
    description: 'claim-policy.revision-invalid (details.issues)',
  })
  @ApiUnsupportedMediaTypeResponse(UNSUPPORTED)
  @ApiServiceUnavailableResponse(UNAVAILABLE)
  postRevision(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('typeId') typeId: string,
    @Body() body: unknown,
  ): Promise<ClaimPolicyRevisionSavedView> {
    return this.#http.post(
      'certification.claim-policy-save-revision',
      context,
      request,
      response,
      body,
      { required: ['version', 'rows'], optional: ['reason'] },
      (input) =>
        this.save.execute(context, {
          typeId,
          version: input.version,
          rows: input.rows,
          reason: input.reason,
        }),
    ) as Promise<ClaimPolicyRevisionSavedView>;
  }

  @Post(':typeId/relaxations/:proposalId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a relaxing policy revision as the second admin',
    description:
      `${EDIT} Under the proposal version read; the requester may not approve. Publishes the ` +
      'pending revision (claim-policy-changed.v1).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: VersionRequest })
  @ApiOkResponse({ type: ClaimPolicyRelaxationApprovedView })
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
  ): Promise<ClaimPolicyRelaxationApprovedView> {
    return this.#http.post(
      'certification.claim-policy-approve-relaxation',
      context,
      request,
      response,
      body,
      { required: ['version'] },
      (input) =>
        this.approveRelaxation.execute(context, { typeId, proposalId, version: input.version }),
    );
  }

  @Post(':typeId/proposals/:proposalId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a pending policy relaxation',
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
      'certification.claim-policy-proposal-reject',
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
    summary: 'Withdraw your own pending policy relaxation',
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
      'certification.claim-policy-proposal-withdraw',
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
