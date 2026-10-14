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
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AssignTeamMemberRole } from '../application/use-cases/assign-team-member-role.use-case';
import { InviteStaff } from '../application/use-cases/invite-staff.use-case';
import {
  ListSellerTeam,
  MAX_SELLER_TEAM_PAGE,
  type SellerTeamPage,
} from '../application/use-cases/list-seller-team.use-case';
import { RemoveTeamMember } from '../application/use-cases/remove-team-member.use-case';
import { ResendStaffInvitation } from '../application/use-cases/resend-staff-invitation.use-case';
import { RevokeStaffInvitation } from '../application/use-cases/revoke-staff-invitation.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import {
  SellerTeamAssignRoleRequest,
  SellerTeamEmptyRequest,
  SellerTeamInvitationChanged,
  SellerTeamInvitationIssued,
  SellerTeamInvitationRowView,
  SellerTeamInviteRequest,
  SellerTeamMemberRemoved,
  SellerTeamMemberRowView,
  SellerTeamPageView,
  SellerTeamRoleAssigned,
} from './seller-team.dto';

/**
 * The HTTP status of each refusal of the seller team routes (identity design 5.2, 8.6 row 1;
 * slice 11). The design names codes, not statuses. Chosen as the admin team's: a resource that is
 * not one of this seller's (or not of the route's kind) is 404, the same answer as a missing one;
 * a rule of R1, R3 or R11 that the actor does not meet is 403; a state that refuses the change
 * (the last Seller Owner, a pending invitation, the member limit) is 409.
 */
export const SELLER_TEAM_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'account.unknown': 404,
  'role.unknown': 404,
  'invitation.unknown': 404,
  'member.self': 403,
  'member.outranks-actor': 403,
  'role.not-grantable': 403,
  'member.last-holder': 409,
  'member.limit': 409,
  'invitation.already-pending': 409,
  'invitation.rejected': 409,
  'request.throttled': 429,
  'access.unavailable': 503,
});

type Refusal = {
  readonly code: string;
  readonly fields?: readonly unknown[];
  readonly retryAfterSeconds?: number;
};

function refusal(error: Refusal, response?: Response): HttpException {
  if (error.retryAfterSeconds !== undefined && response !== undefined) {
    return adminFailure(response, error);
  }
  const status =
    SELLER_TEAM_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  return error.fields === undefined
    ? fail(status, error.code)
    : fail(status, error.code, { fields: error.fields });
}

/** A path id: malformed answers as an unknown resource, byte-identical to a missing one (5.2). */
function pathId<K extends string>(raw: string, unknown: string): Id<K> | HttpException {
  const parsed = parseId<K>(raw);
  return parsed.ok ? parsed.value : refusal({ code: unknown });
}

/** The default page of the team list. */
const DEFAULT_TEAM_PAGE = 50;
const TEAM_QUERY_KEYS: ReadonlySet<string> = new Set(['after', 'limit']);

/**
 * The team list's query: only `after` and `limit`, each at most once (a repeated parameter is an
 * array and refused); `limit` digits only. The use case checks the range and the id. No
 * parameter can name a seller (R6).
 */
function teamQuery(
  query: Record<string, unknown>,
): { after: string | null; limit: number } | HttpException {
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(query)) {
    if (!TEAM_QUERY_KEYS.has(key)) fields.push({ path: key.slice(0, 64), code: 'unknown' });
  }
  const { after, limit } = query;
  if (after !== undefined && typeof after !== 'string') {
    fields.push({ path: 'after', code: 'format' });
  }
  if (limit !== undefined && (typeof limit !== 'string' || !/^[0-9]{1,4}$/.test(limit))) {
    fields.push({ path: 'limit', code: 'format' });
  }
  if (fields.length > 0) {
    return refusal({ code: 'validation.failed', fields: fields.slice(0, 10) });
  }
  return {
    after: typeof after === 'string' ? after : null,
    limit: typeof limit === 'string' ? Number(limit) : DEFAULT_TEAM_PAGE,
  };
}

/** The page as JSON: instants as ISO strings; nothing else is added or dropped. */
function teamPageView(page: SellerTeamPage): SellerTeamPageView {
  return {
    items: page.items.map((row) =>
      row.type === 'account'
        ? row
        : {
            ...row,
            createdAt: row.createdAt.toString(),
            expiresAt: row.expiresAt === null ? null : row.expiresAt.toString(),
          },
    ),
    next: page.next,
  };
}

const ACCOUNT_PARAM = { name: 'accountId', description: 'The account. A UUID v7.' };
const INVITATION_PARAM = { name: 'invitationId', description: 'The invitation. A UUID v7.' };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * Seller team management over HTTP (identity design 3.4, 5.3 to 5.5, 8.6; `ux.md` B1, D1 to D3,
 * F11; slice 11): the team list (members, open Staff invitations and per-row action hints), Staff
 * invitations with their inviter (issue, re-send, revoke), a member's role and removal from the
 * team. The seller is the session's (R6): no route takes a seller id, so another seller's members
 * and invitations are unreachable and answer as missing ones. Every route reads the seller
 * session (`@ReadsSession`), so its unsafe method needs the CSRF token and the seller panel's
 * origin (6.4); JSON only, with a closed body (`{}` where there is no field). Thin adapters: the
 * `CallContext` comes from `@Call()`, each route calls one use case through its gate, which checks
 * the route's permission and that the seller is approved, and maps the answer to the error format
 * of 5.2. Every route logs its outcome code with the correlation id; never an address or a name.
 */
@ApiTags('identity')
@ApiExtraModels(SellerTeamMemberRowView, SellerTeamInvitationRowView)
@RoutePopulation('seller')
@Controller('identity/seller/team')
export class SellerTeamController {
  readonly #logger = new Logger('SellerTeamController');

  constructor(
    private readonly listSellerTeam: ListSellerTeam,
    private readonly inviteStaff: InviteStaff,
    private readonly resendStaffInvitation: ResendStaffInvitation,
    private readonly revokeStaffInvitation: RevokeStaffInvitation,
    private readonly assignTeamMemberRole: AssignTeamMemberRole,
    private readonly removeTeamMember: RemoveTeamMember,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: 'List your team: members with their roles and open Staff invitations',
    description:
      'Needs identity.team-member.view and an approved shop. Active members of your shop and ' +
      'its pending Staff invitations, merged by id (creation order), paged with `after` and ' +
      '`limit`. Each row carries, per action, `allowed` and the code the command would answer ' +
      'now (access.denied for an action whose permission you lack). Hints only: every command ' +
      'checks again. Another shop is never reachable. Not cached.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Rows per page, 1 to ${MAX_SELLER_TEAM_PAGE}; default ${DEFAULT_TEAM_PAGE}.`,
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description: '`next` of the previous page (a UUID v7); absent for the first page.',
  })
  @ApiOkResponse({ type: SellerTeamPageView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async team(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerTeamPageView> {
    const input = teamQuery(query);
    let outcome: SellerTeamPageView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.listSellerTeam.execute(context, input);
      outcome = result.ok ? teamPageView(result.value) : refusal(result.error);
    }
    // Personal data of the team: never stored by a cache.
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.seller-list-team', context, outcome);
  }

  @Post('invitations')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Invite a team member with a role',
    description:
      'Needs identity.team-member.invite (the Seller Owner) and an approved shop. The role must ' +
      'be one you could assign; the Seller Owner role is never offered. One pending invitation ' +
      'per address; a stale one is replaced. The answer is the same for any address. The mail ' +
      'follows shortly. member.limit when members and open invitations reach the Market limit; ' +
      'access.unavailable while the Market sets none.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerTeamInviteRequest })
  @ApiCreatedResponse({ type: SellerTeamInvitationIssued })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'role.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'invitation.already-pending, member.limit, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After): the mail counters',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async invite(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerTeamInvitationIssued> {
    const input = adminBody(request, body, ['email', 'roleId'] as const);
    const client = adminClient(request);
    let outcome: SellerTeamInvitationIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const roleId = parseId<'Role'>(input.roleId);
      const result = roleId.ok
        ? await this.inviteStaff.execute(context, {
            email: input.email,
            roleId: roleId.value,
            origin: client.origin,
          })
        : err({ code: 'validation.failed', fields: [{ path: 'roleId', code: 'format' }] });
      outcome = result.ok
        ? { code: result.value.code, invitationId: result.value.invitationId }
        : refusal(result.error, response);
    }
    return this.settle('identity.seller-invite-staff', context, outcome);
  }

  @Post('invitations/:invitationId/resend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send a pending Staff invitation again',
    description:
      'Needs identity.team-member.invite and a role you could still assign. The earlier link ' +
      'stops working at once; a new mail with a new expiry follows. Counted on the mail counters.',
  })
  @ApiParam(INVITATION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerTeamEmptyRequest })
  @ApiOkResponse({ type: SellerTeamInvitationChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'invitation.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description:
      'invitation.rejected (decided, past its lifetime, its role is gone) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<SellerTeamInvitationChanged> {
    const outcome = await this.onInvitation(
      request,
      response,
      rawInvitationId,
      body,
      (invitationId, origin) =>
        this.resendStaffInvitation.execute(context, { invitationId, origin }),
    );
    return this.settle('identity.seller-resend-staff-invitation', context, outcome);
  }

  @Post('invitations/:invitationId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Revoke a pending Staff invitation',
    description: 'Needs identity.team-member.invite. Its link stops working at once.',
  })
  @ApiParam(INVITATION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerTeamEmptyRequest })
  @ApiOkResponse({ type: SellerTeamInvitationChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'invitation.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'invitation.rejected (already decided) or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async revoke(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('invitationId') rawInvitationId: string,
    @Body() body: unknown,
  ): Promise<SellerTeamInvitationChanged> {
    const outcome = await this.onInvitation(
      request,
      response,
      rawInvitationId,
      body,
      (invitationId, origin) =>
        this.revokeStaffInvitation.execute(context, { invitationId, origin }),
    );
    return this.settle('identity.seller-revoke-staff-invitation', context, outcome);
  }

  @Post('accounts/:accountId/role')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Change a team member's role",
    description:
      'Needs identity.team-member.assign-role (the Seller Owner). Never on yourself; never on ' +
      'a member who holds a permission you lack; never a role with a permission you lack or a ' +
      'protected one, and never the Seller Owner role; never leaves the shop without a Seller ' +
      'Owner who can sign in. Sessions stay: permissions are read on every request.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerTeamAssignRoleRequest })
  @ApiOkResponse({ type: SellerTeamRoleAssigned })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'access.denied, member.self, member.outranks-actor, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown or role.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'member.last-holder, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async assignRole(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<SellerTeamRoleAssigned> {
    const accountId = pathId<'Account'>(rawAccountId, 'account.unknown');
    const input = adminBody(request, body, ['roleId'] as const);
    let outcome: SellerTeamRoleAssigned | HttpException;
    if (accountId instanceof HttpException) outcome = accountId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const roleId = parseId<'Role'>(input.roleId);
      const result = roleId.ok
        ? await this.assignTeamMemberRole.execute(context, { accountId, roleId: roleId.value })
        : err({ code: 'validation.failed', fields: [{ path: 'roleId', code: 'format' }] });
      outcome = result.ok ? result.value : refusal(result.error);
    }
    return this.settle('identity.seller-assign-team-member-role', context, outcome);
  }

  @Post('accounts/:accountId/remove')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Remove a member from your team',
    description:
      'Needs identity.team-member.remove (the Seller Owner). Never yourself; never a member who ' +
      'holds a permission you lack; never the last Seller Owner who can sign in. Their sessions ' +
      'end at once. The person keeps their account and may be invited again.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: SellerTeamEmptyRequest })
  @ApiOkResponse({ type: SellerTeamMemberRemoved })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, member.self, member.outranks-actor or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'member.last-holder, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async remove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<SellerTeamMemberRemoved> {
    const accountId = pathId<'Account'>(rawAccountId, 'account.unknown');
    const input = adminBody(request, body, []);
    let outcome: SellerTeamMemberRemoved | HttpException;
    if (accountId instanceof HttpException) outcome = accountId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.removeTeamMember.execute(context, { accountId });
      outcome = result.ok
        ? { code: result.value.code, accountId: result.value.accountId }
        : refusal(result.error);
    }
    return this.settle('identity.seller-remove-team-member', context, outcome);
  }

  /** A route on one invitation with an empty body: the path id, the body, then the use case. */
  private async onInvitation<T extends { readonly code: string; readonly invitationId: string }>(
    request: Request,
    response: Response,
    rawInvitationId: string,
    body: unknown,
    run: (invitationId: Id<'Invitation'>, origin: string) => Promise<Result<T, Refusal>>,
  ): Promise<{ code: T['code']; invitationId: string } | HttpException> {
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
