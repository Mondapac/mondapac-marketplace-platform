import {
  Body,
  Controller,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminCustomerAddressReveal } from '../application/use-cases/admin-customer-address-reveal.use-case';
import { AdminCustomerAddresses } from '../application/use-cases/admin-customer-addresses.use-case';
import { AdminCustomerGroupCreate } from '../application/use-cases/admin-customer-group-create.use-case';
import { AdminCustomerGroupMembersAdd } from '../application/use-cases/admin-customer-group-members-add.use-case';
import { AdminCustomerGroupMembersRemove } from '../application/use-cases/admin-customer-group-members-remove.use-case';
import { AdminCustomerGroupUpdate } from '../application/use-cases/admin-customer-group-update.use-case';
import { AdminCustomerGroupView } from '../application/use-cases/admin-customer-group-view.use-case';
import { AdminCustomerGroupsList } from '../application/use-cases/admin-customer-groups-list.use-case';
import { AdminCustomerNoteAdd } from '../application/use-cases/admin-customer-note-add.use-case';
import { AdminCustomerNotesList } from '../application/use-cases/admin-customer-notes-list.use-case';
import { AdminCustomerRename } from '../application/use-cases/admin-customer-rename.use-case';
import { AdminCustomerTimelineExport } from '../application/use-cases/admin-customer-timeline-export.use-case';
import { AdminCustomerTimeline } from '../application/use-cases/admin-customer-timeline.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { closedBody, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const SELECTOR = '`ids` (at most 1000) or the Customers list’s `view`, `q` and `filters`';

/**
 * The admin's management of customers over HTTP (customers management phase 2, PR 2a): manual
 * groups and their members, internal notes, the activity timeline and the name edit. Every answer
 * is `Cache-Control: no-store`; a write needs the CSRF token. A group's members are the Customers
 * list with `filters.group` (`POST customers/admin/list`), so they get every super list feature.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin')
export class AdminCustomerManagementController {
  readonly #logger = new Logger('AdminCustomerManagementController');

  constructor(
    private readonly groupsList: AdminCustomerGroupsList,
    private readonly groupView: AdminCustomerGroupView,
    private readonly groupCreate: AdminCustomerGroupCreate,
    private readonly groupUpdate: AdminCustomerGroupUpdate,
    private readonly membersAdd: AdminCustomerGroupMembersAdd,
    private readonly membersRemove: AdminCustomerGroupMembersRemove,
    private readonly notesList: AdminCustomerNotesList,
    private readonly noteAdd: AdminCustomerNoteAdd,
    private readonly timeline: AdminCustomerTimeline,
    private readonly timelineExport: AdminCustomerTimelineExport,
    private readonly rename: AdminCustomerRename,
    private readonly addresses: AdminCustomerAddresses,
    private readonly addressReveal: AdminCustomerAddressReveal,
  ) {}

  @Get('customers/:accountId/addresses')
  @ApiOperation({
    summary: 'A customer’s delivery addresses, as suburb and country (phase 2b)',
    description:
      'Needs customers.customers.view. Each address: id, suburb, country, whether it is the ' +
      'default, created. Nothing else: the full address needs the reveal route and its key. ' +
      '`suburb` is null once the customer’s key is destroyed. 404 customers.customer-not-found.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listAddresses(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.addresses.execute(context, { accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('customers/:accountId/addresses/:addressId/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reveal one of a customer’s delivery addresses in full (phase 2b)',
    description:
      'Needs customers.customers.view and the protected customers.customer-address.reveal. No ' +
      'body (or `{}`). Answers the recipient, phone, street lines, suburb, region, postcode, ' +
      'country and courier note. Every reveal is audited (customers.customer-address.revealed, ' +
      'the address id only) and lands on the customer’s timeline before it is answered. Personal ' +
      'data: not cached. 404 customers.customer-not-found or customers.address-not-found.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({
    ...ERROR,
    description: 'customers.customer-not-found or customers.address-not-found',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async revealAddress(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Param('addressId') addressId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
    ) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: '', code: 'unknown-field' }] },
        },
        400,
      );
    }
    const result = await this.addressReveal.execute(context, { accountId, addressId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Get('groups')
  @ApiOperation({
    summary: 'List the manual customer groups',
    description:
      'Needs customers.customers.view. Every group of the Market (at most 500) with its member ' +
      'count, live ones first, newest first. A group’s members are `POST customers/admin/list` with ' +
      '`filters.group`.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listGroups(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.groupsList.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('groups')
  @ApiOperation({
    summary: 'Make a manual customer group',
    description:
      'Needs customers.customers.view and customers.groups.manage. Body: `name` (1 to 80 ' +
      'characters, one per Market whatever its case) and `description` (optional, at most 500). ' +
      'Labels for admins: do not put personal data in them. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'customers.group-name-taken or customers.group-limit-reached (details.max)',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async createGroup(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['name', 'description']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.groupCreate.execute(context, body);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Get('groups/:groupId')
  @ApiOperation({
    summary: 'One manual customer group',
    description: 'Needs customers.customers.view. 404 customers.group-not-found.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.group-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async group(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('groupId') groupId: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.groupView.execute(context, { groupId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Put('groups/:groupId')
  @ApiOperation({
    summary: 'Rename, describe, archive or restore a manual group',
    description:
      'Needs customers.customers.view and customers.groups.manage. Body: `expectedVersion` (the ' +
      'version shown; a stale one is customers.conflict) and any of `name`, `description` (null ' +
      'or empty clears it) and `archived`. An archived group keeps its members but takes no new ' +
      'ones and no promotion reaches it. The answer of an archive carries `liveSegmentUse`: ' +
      '`some` when a live, waiting or paused promotion’s MANUAL_GROUP segment still names the ' +
      'group (it will match nobody), `none`, or `unknown` when promotions could not say. ' +
      'Advisory: the archive is done either way. Audited, with the same flag.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.group-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'customers.conflict or group-name-taken' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async updateGroup(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      'expectedVersion',
      'name',
      'description',
      'archived',
    ]);
    if (checked instanceof HttpException) throw checked;
    const result = await this.groupUpdate.execute(context, { ...(body as object), groupId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('groups/:groupId/members/add')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add customers to a manual group (one or in bulk)',
    description:
      'Needs customers.customers.view and customers.groups.manage. Body: ' +
      SELECTOR +
      ' ("select all matching", at most 10,000; more is batch.too-large with the total). Customers ' +
      'already in the group and ids that are no customer of the Market are skipped. Answers ' +
      '`changed` and `requested`. Audited; each customer added gets a timeline entry.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.group-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'customers.group-archived' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async addMembers(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['ids', 'view', 'q', 'filters']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.membersAdd.execute(context, { ...(body as object), groupId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('groups/:groupId/members/remove')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove customers from a manual group (one or in bulk)',
    description:
      'Needs customers.customers.view and customers.groups.manage. Body: ' +
      SELECTOR +
      ' (at most 10,000). Customers that are not members are skipped. Audited; each customer ' +
      'removed gets a timeline entry.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.group-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async removeMembers(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['ids', 'view', 'q', 'filters']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.membersRemove.execute(context, { ...(body as object), groupId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Get('customers/:accountId/notes')
  @ApiOperation({
    summary: 'A customer’s internal admin notes',
    description:
      'Needs customers.customers.view. Newest first; query `limit` (1 to 100, default 20) and ' +
      '`cursor` (the `nextCursor` of the page before). A note of an erased customer has no text ' +
      '(`body: null`). 404 customers.customer-not-found. Personal data.',
  })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async notes(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.notesList.execute(context, { ...query, accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('customers/:accountId/notes')
  @ApiOperation({
    summary: 'Write an internal note about a customer',
    description:
      'Needs customers.customers.view and customers.customer-notes.write. Body: `body` (1 to 2000 ' +
      'characters of plain text). Never shown to the customer or a seller; written once, never ' +
      'changed. Sealed under the customer’s key. Audited (id and length) and on the timeline.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async addNote(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['body']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.noteAdd.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('customers/:accountId/activity')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A customer’s activity timeline (super list)',
    description:
      'Needs customers.customers.view. Body: `filters` (`category`: account, orders, reviews or admin; ' +
      '`kinds`: an array of event kinds; `from`, `to`: YYYY-MM-DD in the admin’s own zone, else the Market’s), `direction` (desc, the ' +
      'default, or asc), `page`, `pageSize` (at most 100) and `paging` (pages, with the total, or ' +
      'prev-next, the Market’s List paging setting). Codes and ids only; an admin action names ' +
      'the admin. Every read is an audited open of the page (tab activity).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async activity(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, [
      'filters',
      'sort',
      'direction',
      'page',
      'pageSize',
      'paging',
    ]);
    if (checked instanceof HttpException) throw checked;
    const result = await this.timeline.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Post('customers/:accountId/activity/export')
  @HttpCode(200)
  @RequiresStepUp('customers.customers.export')
  @ApiOperation({
    summary: 'Export a customer’s activity timeline as a CSV or XLSX file',
    description:
      'Needs customers.customers.view and customers.customers.export (protected) and a fresh ' +
      `two-step proof for \`${CUSTOMERS_EXPORT_STEP_UP}\` (spent by the export). Body: ` +
      '`format` (csv, the default, or xlsx), `filters` and `direction` as for the timeline. At ' +
      'most 10,000 entries. Audited (format and count).',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ description: 'text/csv or the .xlsx content type, as an attachment' })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf, second-factor.required or enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max, total)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportActivity(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const checked = closedBody(request, body, ['format', 'filters', 'direction']);
    const result =
      checked instanceof HttpException
        ? null
        : await this.timelineExport.execute(context, { ...(body as object), accountId });
    if (checked instanceof HttpException || result === null || !result.ok) {
      const error =
        checked instanceof HttpException
          ? checked
          : refusal(
              (result as { error: { code: string } & Record<string, unknown> }).error,
              context,
              this.#logger,
            );
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
    } catch {
      this.#logger.warn({
        msg: 'customers.admin-customer-timeline-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  @Put('customers/:accountId/display-name')
  @ApiOperation({
    summary: 'Change a customer’s display name',
    description:
      'Needs customers.customers.view and customers.customers.edit. Body: `displayName` (1 to 100 ' +
      'characters, the holder’s own rules). Identity saves it, records the event and its audit ' +
      'row; the change is on the customer’s timeline. A disabled or unverified account keeps its ' +
      'name (customers.customer-not-eligible). Disabling and enabling stay on ' +
      '`POST identity/admin/customers/:accountId/disable` and `/enable`.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.customer-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'customers.customer-not-eligible' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async displayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, ['displayName']);
    if (checked instanceof HttpException) throw checked;
    const result = await this.rename.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
