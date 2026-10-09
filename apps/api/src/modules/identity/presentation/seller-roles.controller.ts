import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Logger,
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
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
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
import { ListSellerRoles } from '../application/use-cases/list-seller-roles.use-case';
import { CreateSellerRole } from '../application/use-cases/create-seller-role.use-case';
import { DeleteSellerRole } from '../application/use-cases/delete-seller-role.use-case';
import { EditSellerRole } from '../application/use-cases/edit-seller-role.use-case';
import { ApiErrorBody } from './customer-sign-up.dto';
import { RoleCatalogueView, RoleEditorRequest, RoleWrittenView } from './role-editor.dto';
import { catalogueView, roleBody, rolePathId, roleRefusal } from './role-editor.http';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ROLE_PARAM = { name: 'roleId', description: 'The role. A UUID v7.' };
const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';

/**
 * The seller role editor over HTTP (identity design 5.3 `identity.seller-role.*`, 8.6 row 6;
 * slice 10): the catalogue of the seller's roles with per-key and per-action hints, and create,
 * edit and delete of a custom role. The seller is the session's (R6): no route takes a seller
 * id, and the catalogue takes no query parameter. Every route reads the seller session
 * (`@ReadsSession`), so its unsafe method needs the CSRF token and the seller panel's origin
 * (6.4); JSON only. Thin adapters over the use cases and their gate; each logs its outcome code
 * with the correlation id, never a role name or a key.
 */
@ApiTags('identity')
@RoutePopulation('seller')
@Controller('identity/seller')
export class SellerRolesController {
  readonly #logger = new Logger('SellerRolesController');

  constructor(
    private readonly listSellerRoles: ListSellerRoles,
    private readonly createSellerRole: CreateSellerRole,
    private readonly editSellerRole: EditSellerRole,
    private readonly deleteSellerRole: DeleteSellerRole,
  ) {}

  @Get('roles')
  @ReadsSession()
  @ApiOperation({
    summary: 'List the roles of your shop, with their permissions and your options',
    description:
      'Needs identity.seller-role.view. The Market’s shared seller roles and the custom roles of ' +
      'your own shop, by id, with the permissions each confers, `grantable`, what you may do ' +
      '(`actions`) and `keys`: every seller permission with whether you may put it in a custom ' +
      'role. All flags are hints: the commands check again. Another shop’s roles are never ' +
      'returned. No query parameter is accepted. Not cached.',
  })
  @ApiOkResponse({ type: RoleCatalogueView })
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
  ): Promise<RoleCatalogueView> {
    const unknown = Object.keys(query).sort();
    let outcome: RoleCatalogueView | HttpException;
    if (unknown.length > 0) {
      outcome = roleRefusal({
        code: 'validation.failed',
        fields: unknown.slice(0, 10).map((path) => ({ path: path.slice(0, 64), code: 'unknown' })),
      });
    } else {
      const result = await this.listSellerRoles.execute(context, {});
      outcome = result.ok ? catalogueView(result.value) : roleRefusal(result.error);
    }
    response.setHeader('Cache-Control', 'no-store');
    return this.settle('identity.seller-list-roles', context, outcome);
  }

  @Post('roles')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a custom role for your shop',
    description:
      'Needs identity.seller-role.create (the Seller Owner). A name and the whole key set, each ' +
      'key one you may give; protected seller keys are not grantable. At most 40 permissions; ' +
      'the Market limits the custom roles per shop (role.limit; access.unavailable while the ' +
      'Market sets none).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: RoleEditorRequest })
  @ApiCreatedResponse({ type: RoleWrittenView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'role.name-taken, role.limit, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async createRole(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<RoleWrittenView> {
    const input = roleBody(request, body);
    let outcome: RoleWrittenView | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createSellerRole.execute(context, {
        name: input.name,
        permissionKeys: input.permissionKeys as string[],
      });
      outcome = result.ok ? result.value : roleRefusal(result.error);
    }
    return this.settle('identity.seller-create-role', context, outcome);
  }

  @Put('roles/:roleId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Edit a custom role of your shop',
    description:
      'Needs identity.seller-role.edit. Replaces the name and the whole key set of a custom ' +
      'role of your shop. Never a shared role (role.read-only). The same name and keys answer ' +
      'role.unchanged and write nothing. Members holding the role see the change at once.',
  })
  @ApiParam(ROLE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: RoleEditorRequest })
  @ApiOkResponse({ type: RoleWrittenView })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'role.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'role.read-only, role.name-taken, conflict.stale or conflict.retry',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  async editRole(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('roleId') rawRoleId: string,
    @Body() body: unknown,
  ): Promise<RoleWrittenView> {
    const roleId = rolePathId(rawRoleId);
    const input = roleBody(request, body);
    let outcome: RoleWrittenView | HttpException;
    if (roleId instanceof HttpException) outcome = roleId;
    else if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editSellerRole.execute(context, {
        roleId,
        name: input.name,
        permissionKeys: input.permissionKeys as string[],
      });
      outcome = result.ok ? result.value : roleRefusal(result.error);
    }
    return this.settle('identity.seller-edit-role', context, outcome);
  }

  @Delete('roles/:roleId')
  @ReadsSession()
  @ApiOperation({
    summary: 'Delete a custom role of your shop',
    description:
      'Needs identity.seller-role.delete. Only a custom role of your shop that no member ' +
      'holds (role.in-use: reassign first). Open invitations for it can no longer be accepted.',
  })
  @ApiParam(ROLE_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: RoleWrittenView })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'access.denied, role.not-grantable or request.csrf',
  })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'role.unknown' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'role.read-only, role.in-use, conflict.stale or conflict.retry',
  })
  async deleteRole(
    @Call() context: CallContext,
    @Param('roleId') rawRoleId: string,
  ): Promise<RoleWrittenView> {
    const roleId = rolePathId(rawRoleId);
    let outcome: RoleWrittenView | HttpException;
    if (roleId instanceof HttpException) outcome = roleId;
    else {
      const result = await this.deleteSellerRole.execute(context, { roleId });
      outcome = result.ok ? result.value : roleRefusal(result.error);
    }
    return this.settle('identity.seller-delete-role', context, outcome);
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
