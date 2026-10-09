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
import { AssignAdminRole } from '../application/use-cases/assign-admin-role.use-case';
import { DisableAdminAccount } from '../application/use-cases/disable-admin-account.use-case';
import { DisableCustomerAccount } from '../application/use-cases/disable-customer-account.use-case';
import { EnableAdminAccount } from '../application/use-cases/enable-admin-account.use-case';
import { EnableCustomerAccount } from '../application/use-cases/enable-customer-account.use-case';
import { InviteAdmin } from '../application/use-cases/invite-admin.use-case';
import {
  ListAdminTeam,
  MAX_ADMIN_TEAM_PAGE,
  type AdminTeamPage,
} from '../application/use-cases/list-admin-team.use-case';
import {
  ListPlatformRoles,
  type PlatformRoleCatalogue,
} from '../application/use-cases/list-platform-roles.use-case';
import { ResendAdminInvitation } from '../application/use-cases/resend-admin-invitation.use-case';
import { ResetOtherAdminSecondFactor } from '../application/use-cases/reset-other-admin-second-factor.use-case';
import { RevokeAdminInvitation } from '../application/use-cases/revoke-admin-invitation.use-case';
import { adminBody } from './admin.answer';
import {
  AdminAccountStatusChanged,
  AdminAssignRoleRequest,
  AdminEmptyRequest,
  AdminInvitationChanged,
  AdminInvitationIssued,
  AdminInviteRequest,
  AdminRoleAssigned,
  AdminSecondFactorReset,
  AdminTeamAccountRowView,
  AdminTeamInvitationRowView,
  AdminTeamPageView,
  PlatformRoleCatalogueView,
} from './admin-team.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

/**
 * The HTTP status of each refusal of the admin team routes (identity design 5.2, 8.6 row 1;
 * slices 8a-2 and 8b). The design names codes, not statuses. Chosen: a resource that is not one
 * of this Market's (or not of the route's kind) is 404, the same answer as a missing one; a rule
 * of R1 or R3 that the actor does not meet is 403; a state that refuses the change is 409.
 */
export const ADMIN_TEAM_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'account.unknown': 404,
  'role.unknown': 404,
  'invitation.unknown': 404,
  'member.self': 403,
  'member.outranks-actor': 403,
  'role.not-grantable': 403,
  'member.last-holder': 409,
  'account.already-disabled': 409,
  'account.already-active': 409,
  'account.exists': 409,
  'invitation.already-pending': 409,
  'invitation.rejected': 409,
  'second-factor.none': 409,
  'access.unavailable': 503,
});

type Refusal = { readonly code: string; readonly fields?: readonly unknown[] };

function refusal(error: Refusal): HttpException {
  const status =
    ADMIN_TEAM_STATUS[error.code] ??
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
 * The team list's query: only `after` and `limit`, each at most once (a repeated parameter is
 * an array and refused); `limit` digits only. The use case checks the range and the id.
 */
function teamQuery(
  query: Record<string, unknown>,
): { after: string | null; limit: number } | HttpException {
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(query)) {
    if (!TEAM_QUERY_KEYS.has(key)) fields.push({ path: key, code: 'unknown' });
  }
  const { after, limit } = query;
  if (after !== undefined && typeof after !== 'string')
    fields.push({ path: 'after', code: 'format' });
  if (limit !== undefined && (typeof limit !== 'string' || !/^[0-9]{1,4}$/.test(limit))) {
    fields.push({ path: 'limit', code: 'format' });
  }
  if (fields.length > 0) return refusal({ code: 'validation.failed', fields });
  return {
    after: typeof after === 'string' ? after : null,
    limit: typeof limit === 'string' ? Number(limit) : DEFAULT_TEAM_PAGE,
  };
}

/**
 * The role catalogue's query is closed and empty (slice 10a): any parameter, `scope` included,
 * is refused, so no parameter can reach the seller scope.
 */
function rolesQuery(query: Record<string, unknown>): Record<string, never> | HttpException {
  const keys = Object.keys(query).sort();
  if (keys.length === 0) return {};
  return refusal({
    code: 'validation.failed',
    fields: keys.slice(0, 10).map((path) => ({ path: path.slice(0, 64), code: 'unknown' })),
  });
}

/** The catalogue as JSON: exactly the five fields of each role, in a fixed order. */
function catalogueView(catalogue: PlatformRoleCatalogue): PlatformRoleCatalogueView {
  return {
    items: catalogue.items.map(({ roleId, kind, seedCode, permissionCount, grantable }) => ({
      roleId,
      kind,
      seedCode,
      permissionCount,
      grantable,
    })),
  };
}

/** The page as JSON: instants as ISO strings; nothing else is added or dropped. */
function teamPageView(page: AdminTeamPage): AdminTeamPageView {
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
 * Admin team management over HTTP (identity design 3.1, 3.4, 3.6, 5.3 to 5.5, 7.3, 8.6; slices
 * 8a-2, 8b, 8c and 10a): the team list (accounts, open invitations and per-row action hints),
 * the platform role catalogue with a `grantable` hint per role, an
 * admin's role, admin invitations with their inviter, disabling and enabling admin and customer
 * accounts, and resetting another admin's second factor. Every route reads the
 * admin session of the request's Market (`@ReadsSession`), so its unsafe method needs the CSRF
 * token and the admin panel's origin (6.4); JSON only, with a closed body (`{}` where there is
 * no field). Thin adapters: the `CallContext` comes from `@Call()`, each route calls one use case
 * through its gate, which checks the route's permission, and maps the answer to the error format
 * of 5.2. Every route logs its outcome code with the correlation id; never an address or a name.
 */
@ApiTags('identity')
@ApiExtraModels(AdminTeamAccountRowView, AdminTeamInvitationRowView)
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminTeamController {
  readonly #logger = new Logger('AdminTeamController');

  constructor(
    private readonly assignAdminRole: AssignAdminRole,
    private readonly inviteAdmin: InviteAdmin,
    private readonly resendAdminInvitation: ResendAdminInvitation,
    private readonly revokeAdminInvitation: RevokeAdminInvitation,
    private readonly disableAdminAccount: DisableAdminAccount,
    private readonly enableAdminAccount: EnableAdminAccount,
    private readonly disableCustomerAccount: DisableCustomerAccount,
    private readonly enableCustomerAccount: EnableCustomerAccount,
    private readonly resetOtherAdminSecondFactor: ResetOtherAdminSecondFactor,
    private readonly listAdminTeam: ListAdminTeam,
    private readonly listPlatformRoles: ListPlatformRoles,
  ) {}

  @Get('roles')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the platform roles of the Market, with whether you may give each',
    description:
      'Needs identity.platform-role.view. The platform roles of the Market, by id: id, kind, ' +
      'seed code (the label key of a seeded role), how many permissions each confers, and ' +
      '`grantable`, whether you may give it now. `grantable` is a hint: assigning a role and ' +
      'inviting an admin check again. No name, description or permission list (slice 10), and ' +
      'never a seller role. No query parameter is accepted. Not cached.',
  })
  @ApiOkResponse({ type: PlatformRoleCatalogueView })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed: any query parameter (details.fields)',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  async roles(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformRoleCatalogueView> {
    const input = rolesQuery(query);
    let outcome: PlatformRoleCatalogueView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.listPlatformRoles.execute(context, input);
      outcome = result.ok ? catalogueView(result.value) : refusal(result.error);
    }
    // What the actor may grant: never stored by a cache.
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.admin-list-roles', context, outcome);
  }

  @Get('team')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the admin team: admin accounts with their roles and open invitations',
    description:
      'Needs identity.admin-account.view. Admin accounts and pending admin invitations of the ' +
      'Market, merged by id (creation order), paged with `after` and `limit`. Each row carries, ' +
      'per action, `allowed` and the code the command would answer now (access.denied for an ' +
      'action whose permission the actor lacks). Hints only: every command checks again. Not ' +
      'cached.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `Rows per page, 1 to ${MAX_ADMIN_TEAM_PAGE}; default ${DEFAULT_TEAM_PAGE}.`,
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description: '`next` of the previous page (a UUID v7); absent for the first page.',
  })
  @ApiOkResponse({ type: AdminTeamPageView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async team(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminTeamPageView> {
    const input = teamQuery(query);
    let outcome: AdminTeamPageView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.listAdminTeam.execute(context, input);
      outcome = result.ok ? teamPageView(result.value) : refusal(result.error);
    }
    // Personal data of the team: never stored by a cache.
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.admin-list-team', context, outcome);
  }

  @Post('accounts/:accountId/role')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Change an admin's role",
    description:
      'Needs identity.platform-role.assign. Never on oneself; never on an admin who holds a ' +
      'permission the actor lacks; never a role with a permission the actor lacks, or a ' +
      'protected one without the Platform Administrator role; never leaves the Market without ' +
      'a Platform Administrator who can sign in. Sessions stay: permissions are read on every ' +
      'request.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminAssignRoleRequest })
  @ApiOkResponse({ type: AdminRoleAssigned })
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
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async assignRole(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminRoleAssigned> {
    const accountId = pathId<'Account'>(rawAccountId, 'account.unknown');
    const input = adminBody(request, body, ['roleId'] as const);
    let outcome: AdminRoleAssigned | HttpException;
    if (accountId instanceof HttpException) outcome = accountId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const roleId = parseId<'Role'>(input.roleId);
      const result = roleId.ok
        ? await this.assignAdminRole.execute(context, { accountId, roleId: roleId.value })
        : err({ code: 'validation.failed', fields: [{ path: 'roleId', code: 'format' }] });
      outcome = result.ok ? result.value : refusal(result.error);
    }
    return this.settle('identity.admin-assign-role', context, outcome);
  }

  @Post('invitations')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Invite an admin with a role',
    description:
      'Needs identity.admin-account.invite. The actor is the inviter: the role must be one it ' +
      'could assign, and the acceptance checks again that it still is active and could. One ' +
      'pending invitation per address; a stale one is replaced. The mail follows shortly.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminInviteRequest })
  @ApiCreatedResponse({ type: AdminInvitationIssued })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'role.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'account.exists, invitation.already-pending or conflict.stale',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async invite(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<AdminInvitationIssued> {
    const input = adminBody(request, body, ['email', 'roleId'] as const);
    let outcome: AdminInvitationIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const roleId = parseId<'Role'>(input.roleId);
      const result = roleId.ok
        ? await this.inviteAdmin.execute(context, { email: input.email, roleId: roleId.value })
        : err({ code: 'validation.failed', fields: [{ path: 'roleId', code: 'format' }] });
      outcome = result.ok
        ? { code: result.value.code, invitationId: result.value.invitationId }
        : refusal(result.error);
    }
    return this.settle('identity.admin-invite', context, outcome);
  }

  @Post('invitations/:invitationId/resend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Send a pending admin invitation again',
    description:
      'Needs identity.admin-account.invite and a role the actor could still assign. The ' +
      'earlier link stops working at once; a new mail with a new expiry follows.',
  })
  @ApiParam(INVITATION_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminInvitationChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'invitation.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'invitation.rejected (decided, or its role is gone) or conflict.stale',
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
      this.resendAdminInvitation.execute(context, { invitationId }),
    );
    return this.settle('identity.admin-resend-invitation', context, outcome);
  }

  @Post('invitations/:invitationId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Revoke a pending admin invitation',
    description: 'Needs identity.admin-account.invite. Its link stops working at once.',
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
      this.revokeAdminInvitation.execute(context, { invitationId }),
    );
    return this.settle('identity.admin-revoke-invitation', context, outcome);
  }

  @Post('accounts/:accountId/disable')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Disable an admin account',
    description:
      'Needs identity.admin-account.disable. Every session of the account ends and its open ' +
      'sign-ins are void. Never oneself, never an admin who holds a permission the actor ' +
      'lacks, never the last Platform Administrator who can sign in.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminAccountStatusChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, member.self, member.outranks-actor or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'account.already-disabled, member.last-holder, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async disableAdmin(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminAccountStatusChanged> {
    const outcome = await this.onAccount(request, rawAccountId, body, (accountId) =>
      this.disableAdminAccount.execute(context, { accountId }),
    );
    return this.settle('identity.admin-disable-admin', context, outcome);
  }

  @Post('accounts/:accountId/enable')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Enable a disabled admin account again',
    description: 'Needs identity.admin-account.disable; the guards of a disable but the last one.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminAccountStatusChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, member.self, member.outranks-actor or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'account.already-active, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async enableAdmin(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminAccountStatusChanged> {
    const outcome = await this.onAccount(request, rawAccountId, body, (accountId) =>
      this.enableAdminAccount.execute(context, { accountId }),
    );
    return this.settle('identity.admin-enable-admin', context, outcome);
  }

  @Post('customers/:accountId/disable')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Disable a customer account',
    description:
      'Needs identity.customer-account.disable. Every session of the account ends; it cannot ' +
      'sign in until it is enabled again.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminAccountStatusChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'account.already-disabled, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async disableCustomer(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminAccountStatusChanged> {
    const outcome = await this.onAccount(request, rawAccountId, body, (accountId) =>
      this.disableCustomerAccount.execute(context, { accountId }),
    );
    return this.settle('identity.admin-disable-customer', context, outcome);
  }

  @Post('customers/:accountId/enable')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Enable a disabled customer account again',
    description: 'Needs identity.customer-account.disable.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminAccountStatusChanged })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'account.already-active, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async enableCustomer(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminAccountStatusChanged> {
    const outcome = await this.onAccount(request, rawAccountId, body, (accountId) =>
      this.enableCustomerAccount.execute(context, { accountId }),
    );
    return this.settle('identity.admin-enable-customer', context, outcome);
  }

  @Post('accounts/:accountId/second-factor/reset')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Reset another admin's second factor",
    description:
      'Needs identity.admin-account.reset-second-factor. The factor and its recovery codes are ' +
      'removed, every session of the account ends and the account is mailed; its next sign-in ' +
      "mails an enrolment link. Never one's own factor; never an admin who holds a permission " +
      'the actor lacks.',
  })
  @ApiParam(ACCOUNT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminEmptyRequest })
  @ApiOkResponse({ type: AdminSecondFactorReset })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, member.self, member.outranks-actor or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'account.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'second-factor.none, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async resetSecondFactor(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('accountId') rawAccountId: string,
    @Body() body: unknown,
  ): Promise<AdminSecondFactorReset> {
    const outcome = await this.onAccount(request, rawAccountId, body, (accountId) =>
      this.resetOtherAdminSecondFactor.execute(context, { accountId }),
    );
    return this.settle('identity.admin-reset-second-factor', context, outcome);
  }

  /** A route on one account with an empty body: the path id, the body, then the use case. */
  private async onAccount<T extends { readonly code: string; readonly accountId: string }>(
    request: Request,
    rawAccountId: string,
    body: unknown,
    run: (accountId: Id<'Account'>) => Promise<Result<T, Refusal>>,
  ): Promise<{ code: T['code']; accountId: string } | HttpException> {
    const accountId = pathId<'Account'>(rawAccountId, 'account.unknown');
    if (accountId instanceof HttpException) return accountId;
    const input = adminBody(request, body, []);
    if (input instanceof HttpException) return input;
    const result = await run(accountId);
    return result.ok
      ? { code: result.value.code, accountId: result.value.accountId }
      : refusal(result.error);
  }

  /** A route on one invitation with an empty body. */
  private async onInvitation<T extends { readonly code: string; readonly invitationId: string }>(
    request: Request,
    rawInvitationId: string,
    body: unknown,
    run: (invitationId: Id<'Invitation'>) => Promise<Result<T, Refusal>>,
  ): Promise<{ code: T['code']; invitationId: string } | HttpException> {
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
