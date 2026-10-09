import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Req,
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
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  ApproveSellerAccess,
  type SellerAccessDecided,
  type SellerAccessDecisionFailure,
} from '../application/use-cases/approve-seller-access.use-case';
import { InviteSeller } from '../application/use-cases/invite-seller.use-case';
import { RejectSellerAccess } from '../application/use-cases/reject-seller-access.use-case';
import { ReinstateSellerAccess } from '../application/use-cases/reinstate-seller-access.use-case';
import {
  ResendSellerInvitation,
  type SellerOwnerInvitationChanged,
  type SellerOwnerInvitationFailure,
} from '../application/use-cases/resend-seller-invitation.use-case';
import { RevokeSellerInvitation } from '../application/use-cases/revoke-seller-invitation.use-case';
import { SuspendSellerAccess } from '../application/use-cases/suspend-seller-access.use-case';
import { adminBody } from './admin.answer';
import {
  AdminSellerAccessDecided,
  AdminSellerInvitationIssued,
  AdminSellerInviteRequest,
  AdminSellerReasonRequest,
} from './admin-sellers.dto';
import { AdminEmptyRequest, AdminInvitationChanged } from './admin-team.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

/**
 * The HTTP status of each refusal of the admin seller routes (identity design 3.3, 5.2, 8.6 row
 * 1; slice 9). A seller or invitation that is not one of this Market's is 404, as a missing one;
 * a reason that is refused is a field error (400); a state that refuses the change is 409.
 */
export const ADMIN_SELLERS_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'seller-access.reason-required': 400,
  'seller.unknown': 404,
  'invitation.unknown': 404,
  'seller-access.wrong-state': 409,
  'seller-access.owner-unverified': 409,
  'seller.has-members': 409,
  'account.exists': 409,
  'invitation.already-pending': 409,
  'invitation.rejected': 409,
  'access.unavailable': 503,
});

type Refusal = {
  readonly code: string;
  readonly fields?: readonly unknown[];
  readonly rule?: string;
};

function refusal(error: Refusal): HttpException {
  const status =
    ADMIN_SELLERS_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  // A reason refused for its length or characters (HF13): the rule, never the text.
  if (error.rule !== undefined) {
    return fail(status, error.code, { fields: [{ path: 'reason', code: error.rule }] });
  }
  return fail(status, error.code);
}

/** A path id: malformed answers as an unknown resource, byte-identical to a missing one (5.2). */
function pathId<K extends string>(raw: string, unknown: string): Id<K> | HttpException {
  const parsed = parseId<K>(raw);
  return parsed.ok ? parsed.value : refusal({ code: unknown });
}

/** The answer of a decision: ids and codes; never the reason. */
function decided(value: SellerAccessDecided): AdminSellerAccessDecided {
  return {
    code: value.code,
    sellerId: value.sellerId,
    state: value.state,
    decisionId: value.decisionId,
  };
}

const SELLER_PARAM = { name: 'sellerId', description: 'The seller. A UUID v7.' };
const INVITATION_PARAM = { name: 'invitationId', description: 'The invitation. A UUID v7.' };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const DECISION_CONFLICT =
  'seller-access.wrong-state (the state changed meanwhile), conflict.stale or conflict.retry';

/**
 * Admin decisions on sellers and seller invitations over HTTP (identity design 3.3, 3.4, 8.6;
 * `ux.md` F9, D3 to D6; SEL-03, SEL-06, SEL-07; slice 9). Every route reads the admin session of
 * the request's Market (`@ReadsSession`), so its unsafe method needs the CSRF token and the admin
 * panel's origin (6.4); JSON only, with a closed body. Thin adapters: the `CallContext` comes from
 * `@Call()`, each route calls one use case through its gate, which checks the route's permission,
 * and maps the answer to the error format of 5.2. Every route logs its outcome code with the
 * correlation id; never a reason, an address or a name.
 *
 * Approve and reject leave this controller when `sellers` has its review (ADR-0022 decision 4;
 * `sellers` design R-1); suspend, reinstate and the invitations stay.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminSellersController {
  readonly #logger = new Logger('AdminSellersController');

  constructor(
    private readonly approveSellerAccess: ApproveSellerAccess,
    private readonly rejectSellerAccess: RejectSellerAccess,
    private readonly suspendSellerAccess: SuspendSellerAccess,
    private readonly reinstateSellerAccess: ReinstateSellerAccess,
    private readonly inviteSeller: InviteSeller,
    private readonly resendSellerInvitation: ResendSellerInvitation,
    private readonly revokeSellerInvitation: RevokeSellerInvitation,
  ) {}

  @Post('sellers/:sellerId/approve')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Approve a seller waiting for approval',
    description:
      'Needs identity.seller-access.approve. Only a pending seller whose owner has a confirmed ' +
      'email. The owner is mailed.',
  })
  @ApiParam(SELLER_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminSellerAccessDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: `seller-access.owner-unverified, ${DECISION_CONFLICT}`,
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async approve(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerAccessDecided> {
    const outcome = await this.onSeller(request, rawSellerId, body, false, (sellerId) =>
      this.approveSellerAccess.execute(context, { sellerId, basisId: null }),
    );
    return this.settle('identity.admin-approve-seller', context, outcome);
  }

  @Post('sellers/:sellerId/reject')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reject a seller waiting for approval, with a reason',
    description:
      'Needs identity.seller-access.approve. Only a pending seller. The reason is stored ' +
      "encrypted and mailed to the Seller Owner only; every session of the seller's accounts " +
      'ends.',
  })
  @ApiParam(SELLER_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminSellerReasonRequest })
  @ApiOkResponse({ type: AdminSellerAccessDecided })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'seller-access.reason-required, or validation.failed (details.fields; the reason with ' +
      'code length or characters)',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.unknown' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECISION_CONFLICT })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async reject(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerAccessDecided> {
    const outcome = await this.onSeller(request, rawSellerId, body, true, (sellerId, reason) =>
      this.rejectSellerAccess.execute(context, { sellerId, reason, basisId: null }),
    );
    return this.settle('identity.admin-reject-seller', context, outcome);
  }

  @Post('sellers/:sellerId/suspend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Suspend an approved seller, with a reason',
    description:
      'Needs identity.seller-access.suspend. Only an approved seller. Every session of the ' +
      "seller's accounts ends and none can sign in while suspended; the reason is stored " +
      'encrypted and mailed to the Seller Owner only.',
  })
  @ApiParam(SELLER_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminSellerReasonRequest })
  @ApiOkResponse({ type: AdminSellerAccessDecided })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'seller-access.reason-required, or validation.failed (details.fields; the reason with ' +
      'code length or characters)',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.unknown' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECISION_CONFLICT })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async suspend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerAccessDecided> {
    const outcome = await this.onSeller(request, rawSellerId, body, true, (sellerId, reason) =>
      this.suspendSellerAccess.execute(context, { sellerId, reason }),
    );
    return this.settle('identity.admin-suspend-seller', context, outcome);
  }

  @Post('sellers/:sellerId/reinstate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Lift a seller's suspension",
    description:
      'Needs identity.seller-access.suspend. Only a suspended seller. The owner is mailed.',
  })
  @ApiParam(SELLER_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminSellerAccessDecided })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.unknown' })
  @ApiConflictResponse({ type: ApiErrorBody, description: DECISION_CONFLICT })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async reinstate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerAccessDecided> {
    const outcome = await this.onSeller(request, rawSellerId, body, false, (sellerId) =>
      this.reinstateSellerAccess.execute(context, { sellerId }),
    );
    return this.settle('identity.admin-reinstate-seller', context, outcome);
  }

  @Post('seller-invitations')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Add a seller by inviting its owner',
    description:
      'Needs identity.seller-account.create. Creates the seller (waiting for approval where ' +
      'the Market requires it) and its owner invitation; the mail follows shortly. An address ' +
      'that already has a seller account is refused.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminSellerInviteRequest })
  @ApiCreatedResponse({ type: AdminSellerInvitationIssued })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'account.exists or conflict.stale' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable (the Market configures no seller invitation)',
  })
  async invite(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<AdminSellerInvitationIssued> {
    const input = adminBody(request, body, ['email', 'displayName'] as const);
    let outcome: AdminSellerInvitationIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.inviteSeller.execute(context, input);
      outcome = result.ok ? issued(result.value) : refusal(result.error);
    }
    return this.settle('identity.admin-invite-seller', context, outcome);
  }

  @Post('sellers/:sellerId/invitations')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Invite an owner to a seller that never had a member',
    description:
      'Needs identity.seller-account.create. For a seller created by an invitation that was ' +
      'revoked or expired. A pending invitation of the seller is replaced only once it is stale.',
  })
  @ApiParam(SELLER_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminSellerInviteRequest })
  @ApiCreatedResponse({ type: AdminSellerInvitationIssued })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'seller.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'seller.has-members, account.exists, invitation.already-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async inviteToSeller(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerInvitationIssued> {
    const sellerId = pathId<'Seller'>(rawSellerId, 'seller.unknown');
    const input = adminBody(request, body, ['email', 'displayName'] as const);
    let outcome: AdminSellerInvitationIssued | HttpException;
    if (sellerId instanceof HttpException) outcome = sellerId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.inviteSeller.execute(context, { ...input, sellerId });
      outcome = result.ok ? issued(result.value) : refusal(result.error);
    }
    return this.settle('identity.admin-invite-seller-owner', context, outcome);
  }

  @Post('seller-invitations/:invitationId/resend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Send a pending seller owner's invitation again",
    description:
      'Needs identity.seller-account.create. The earlier link stops working at once; a new ' +
      'mail with a new expiry follows.',
  })
  @ApiParam(INVITATION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminInvitationChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'invitation.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'invitation.rejected (decided or past its lifetime) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<AdminInvitationChanged> {
    const outcome = await this.onInvitation(request, rawInvitationId, body, (invitationId) =>
      this.resendSellerInvitation.execute(context, { invitationId }),
    );
    return this.settle('identity.admin-resend-seller-invitation', context, outcome);
  }

  @Post('seller-invitations/:invitationId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Revoke a pending seller owner's invitation",
    description:
      'Needs identity.seller-account.create. Its link stops working at once; the seller stays ' +
      'and can be invited again.',
  })
  @ApiParam(INVITATION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminInvitationChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'invitation.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'invitation.rejected (already decided) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async revoke(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<AdminInvitationChanged> {
    const outcome = await this.onInvitation(request, rawInvitationId, body, (invitationId) =>
      this.revokeSellerInvitation.execute(context, { invitationId }),
    );
    return this.settle('identity.admin-revoke-seller-invitation', context, outcome);
  }

  /** A decision route: the path id, the body (`{}` or `{ reason }`), then the use case. */
  private async onSeller(
    request: Request,
    rawSellerId: string,
    body: unknown,
    withReason: boolean,
    run: (
      sellerId: Id<'Seller'>,
      reason: string | undefined,
    ) => Promise<Result<SellerAccessDecided, AccessDenied | SellerAccessDecisionFailure>>,
  ): Promise<AdminSellerAccessDecided | HttpException> {
    const sellerId = pathId<'Seller'>(rawSellerId, 'seller.unknown');
    if (sellerId instanceof HttpException) return sellerId;
    const input = withReason
      ? adminBody(request, body, ['reason'] as const)
      : adminBody(request, body, []);
    if (input instanceof HttpException) return input;
    const reason = withReason ? (input as { readonly reason: string }).reason : undefined;
    const result = await run(sellerId, reason);
    return result.ok ? decided(result.value) : refusal(result.error);
  }

  /** A route on one seller-owner invitation with an empty body. */
  private async onInvitation(
    request: Request,
    rawInvitationId: string,
    body: unknown,
    run: (
      invitationId: Id<'Invitation'>,
    ) => Promise<Result<SellerOwnerInvitationChanged, AccessDenied | SellerOwnerInvitationFailure>>,
  ): Promise<AdminInvitationChanged | HttpException> {
    const invitationId = pathId<'Invitation'>(rawInvitationId, 'invitation.unknown');
    if (invitationId instanceof HttpException) return invitationId;
    const input = adminBody(request, body, []);
    if (input instanceof HttpException) return input;
    const result = await run(invitationId);
    return result.ok
      ? { code: result.value.code, invitationId: result.value.invitationId }
      : refusal(result.error);
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : ((outcome as { code?: string }).code ?? 'ok'),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}

/** The answer of an issued seller invitation: ids only. */
function issued(value: {
  readonly code: 'invitation.issued';
  readonly invitationId: string;
  readonly sellerId: string;
}): AdminSellerInvitationIssued {
  return { code: value.code, invitationId: value.invitationId, sellerId: value.sellerId };
}
