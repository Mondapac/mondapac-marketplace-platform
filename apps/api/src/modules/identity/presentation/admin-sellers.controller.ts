import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
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
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import type {
  SellerAccessDecided,
  SellerAccessDecisionFailure,
} from '../application/use-cases/approve-seller-access.use-case';
import { InviteSeller } from '../application/use-cases/invite-seller.use-case';
import {
  ListSellerAccounts,
  MAX_SELLER_LIST_PAGE,
  SELLER_LIST_FILTERS,
  type SellerListPage,
} from '../application/use-cases/list-seller-accounts.use-case';
import { ReinstateSellerAccess } from '../application/use-cases/reinstate-seller-access.use-case';
import {
  ResendSellerInvitation,
  type SellerOwnerInvitationChanged,
  type SellerOwnerInvitationFailure,
} from '../application/use-cases/resend-seller-invitation.use-case';
import { RevokeSellerInvitation } from '../application/use-cases/revoke-seller-invitation.use-case';
import { SuspendSellerAccess } from '../application/use-cases/suspend-seller-access.use-case';
import { adminBody, adminClient } from './admin.answer';
import {
  AdminSellerAccessDecided,
  AdminSellerInvitationIssued,
  AdminSellerInviteRequest,
  AdminSellerListInvitationRowView,
  AdminSellerListPageView,
  AdminSellerListSellerRowView,
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
  'request.throttled': 429,
  'access.unavailable': 503,
});

type Refusal = {
  readonly code: string;
  readonly fields?: readonly unknown[];
  readonly rule?: string;
  readonly retryAfterSeconds?: number;
};

function refusal(error: Refusal, response?: Response): HttpException {
  const status =
    ADMIN_SELLERS_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  // The invitation mail's counters (6.8; Hassan M1): 429 with Retry-After.
  if (error.retryAfterSeconds !== undefined) {
    response?.setHeader('Retry-After', String(error.retryAfterSeconds));
    return fail(status, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
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

/** The default page of the seller list. */
const DEFAULT_SELLER_PAGE = 50;
const SELLER_LIST_QUERY_KEYS: ReadonlySet<string> = new Set(['after', 'limit', 'state', 'email']);

/**
 * The seller list's query: only `after`, `limit`, `state` and `email`, each at most once (a
 * repeated parameter is an array and refused); `limit` digits only. The use case checks the
 * range, the id, the state and the address. A refused field is named, never its value.
 */
function sellerListQuery(
  query: Record<string, unknown>,
):
  | { after: string | null; limit: number; state: string | null; email: string | null }
  | HttpException {
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(query).sort().slice(0, 10)) {
    if (!SELLER_LIST_QUERY_KEYS.has(key)) fields.push({ path: key.slice(0, 64), code: 'unknown' });
  }
  const { after, limit, state, email } = query;
  for (const [path, value] of [
    ['after', after],
    ['state', state],
    ['email', email],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') fields.push({ path, code: 'format' });
  }
  if (limit !== undefined && (typeof limit !== 'string' || !/^[0-9]{1,4}$/.test(limit))) {
    fields.push({ path: 'limit', code: 'format' });
  }
  if (fields.length > 0) return refusal({ code: 'validation.failed', fields });
  return {
    after: typeof after === 'string' ? after : null,
    limit: typeof limit === 'string' ? Number(limit) : DEFAULT_SELLER_PAGE,
    state: typeof state === 'string' ? state : null,
    email: typeof email === 'string' ? email : null,
  };
}

/** The page as JSON: instants as ISO strings; nothing else is added or dropped. */
function sellerPageView(page: SellerListPage): AdminSellerListPageView {
  return {
    items: page.items.map((row) =>
      row.type === 'seller'
        ? { ...row, stateChangedAt: row.stateChangedAt.toString() }
        : {
            ...row,
            createdAt: row.createdAt.toString(),
            expiresAt: row.expiresAt === null ? null : row.expiresAt.toString(),
          },
    ),
    next: page.next,
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
 * Approve and reject are not here: `sellers`' review decides on a submission and calls them
 * through the seller-access contract with its `basisId` (ADR-0022 decision 4; `sellers` design R-1,
 * slice 7a-decide). Suspend, reinstate and the invitations stay.
 */
@ApiTags('identity')
@ApiExtraModels(AdminSellerListSellerRowView, AdminSellerListInvitationRowView)
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminSellersController {
  readonly #logger = new Logger('AdminSellersController');

  constructor(
    private readonly suspendSellerAccess: SuspendSellerAccess,
    private readonly reinstateSellerAccess: ReinstateSellerAccess,
    private readonly inviteSeller: InviteSeller,
    private readonly resendSellerInvitation: ResendSellerInvitation,
    private readonly revokeSellerInvitation: RevokeSellerInvitation,
    private readonly listSellerAccounts: ListSellerAccounts,
  ) {}

  @Get('sellers')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the sellers of the Market and the open seller invitations',
    description:
      'Needs identity.seller-access.view. Sellers whose owner confirmed the email, with the ' +
      "owner's name and address, and the open seller-owner invitations, merged by id (creation " +
      'order), paged with `after` and `limit`. `state` filters: pending, approved, rejected, ' +
      'suspended, or invited (the invitations only); absent lists both. `email` finds an exact ' +
      'address (the owner or the invitee), never a part of one. Each row carries, per action, ' +
      '`allowed` and the code the command would answer now (access.denied for an action whose ' +
      'permission the actor lacks). Hints only: every command checks again. Never a reason. Not ' +
      'cached.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Rows per page, 1 to ${MAX_SELLER_LIST_PAGE}; default ${DEFAULT_SELLER_PAGE}.`,
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description: '`next` of the previous page (a UUID v7); absent for the first page.',
  })
  @ApiQuery({ name: 'state', required: false, enum: SELLER_LIST_FILTERS })
  @ApiQuery({
    name: 'email',
    required: false,
    description: 'An exact address; matched trimmed and case-insensitively. Never logged.',
  })
  @ApiOkResponse({ type: AdminSellerListPageView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async sellers(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminSellerListPageView> {
    const input = sellerListQuery(query);
    let outcome: AdminSellerListPageView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.listSellerAccounts.execute(context, input);
      outcome = result.ok ? sellerPageView(result.value) : refusal(result.error);
    }
    // Owners' and invitees' names and addresses: never stored by a cache.
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.admin-list-sellers', context, outcome);
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
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'account.exists, invitation.already-pending (a pending owner invitation for the address ' +
      'in this Market) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description:
      'request.throttled (details.retryAfterSeconds, Retry-After): the invitation mail counters ' +
      'of the address or the client are used up',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable (the Market configures no seller invitation)',
  })
  async invite(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminSellerInvitationIssued> {
    const input = adminBody(request, body, ['email', 'displayName'] as const);
    const client = adminClient(request);
    let outcome: AdminSellerInvitationIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.inviteSeller.execute(context, { ...input, origin: client.origin });
      outcome = result.ok ? issued(result.value) : refusal(result.error, response);
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
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description:
      'request.throttled (details.retryAfterSeconds, Retry-After): the invitation mail counters ' +
      'of the address or the client are used up',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async inviteToSeller(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('sellerId') rawSellerId: string,
    @Body() body: unknown,
  ): Promise<AdminSellerInvitationIssued> {
    const sellerId = pathId<'Seller'>(rawSellerId, 'seller.unknown');
    const input = adminBody(request, body, ['email', 'displayName'] as const);
    const client = adminClient(request);
    let outcome: AdminSellerInvitationIssued | HttpException;
    if (sellerId instanceof HttpException) outcome = sellerId;
    else if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.inviteSeller.execute(context, {
        ...input,
        sellerId,
        origin: client.origin,
      });
      outcome = result.ok ? issued(result.value) : refusal(result.error, response);
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
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description:
      'request.throttled (details.retryAfterSeconds, Retry-After): the invitation mail counters ' +
      'of the address or the client are used up',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<AdminInvitationChanged> {
    const outcome = await this.onInvitation(
      request,
      response,
      rawInvitationId,
      body,
      (invitationId, origin) =>
        this.resendSellerInvitation.execute(context, { invitationId, origin }),
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
    @Res({ passthrough: true }) response: Response,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<AdminInvitationChanged> {
    const outcome = await this.onInvitation(
      request,
      response,
      rawInvitationId,
      body,
      (invitationId, origin) =>
        this.revokeSellerInvitation.execute(context, { invitationId, origin }),
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
    response: Response,
    rawInvitationId: string,
    body: unknown,
    run: (
      invitationId: Id<'Invitation'>,
      origin: string,
    ) => Promise<Result<SellerOwnerInvitationChanged, AccessDenied | SellerOwnerInvitationFailure>>,
  ): Promise<AdminInvitationChanged | HttpException> {
    const invitationId = pathId<'Invitation'>(rawInvitationId, 'invitation.unknown');
    if (invitationId instanceof HttpException) return invitationId;
    const input = adminBody(request, body, []);
    if (input instanceof HttpException) return input;
    const client = adminClient(request);
    if (client instanceof HttpException) return client;
    const result = await run(invitationId, client.origin);
    return result.ok
      ? { code: result.value.code, invitationId: result.value.invitationId }
      : refusal(result.error, response);
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
