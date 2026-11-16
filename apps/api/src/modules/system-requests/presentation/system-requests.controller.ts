import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiQuery,
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
import {
  ApproveMatchingSystemRequests,
  MATCHING_FIELDS,
} from '../application/use-cases/approve-matching-system-requests.use-case';
import { ApproveSystemRequest } from '../application/use-cases/approve-system-request.use-case';
import { ApproveSystemRequests } from '../application/use-cases/approve-system-requests.use-case';
import { ChangeAreaReviewPolicy } from '../application/use-cases/change-area-review-policy.use-case';
import { ChangeReviewDueDays } from '../application/use-cases/change-review-due-days.use-case';
import { CommentOnSystemRequest } from '../application/use-cases/comment-on-system-request.use-case';
import { CountSystemRequests } from '../application/use-cases/count-system-requests.use-case';
import { ListSystemRequests } from '../application/use-cases/list-system-requests.use-case';
import { RejectSystemRequest } from '../application/use-cases/reject-system-request.use-case';
import { ViewReviewPolicy } from '../application/use-cases/view-review-policy.use-case';
import { ViewSystemRequest } from '../application/use-cases/view-system-request.use-case';
import { WithdrawSystemRequest } from '../application/use-cases/withdraw-system-request.use-case';
import { POLICY_AREAS, REVIEW_AREAS, RISKS } from '../domain/areas';
import { REQUEST_STATUSES, REQUEST_VIEWS } from '../domain/request';
import { closedBody, refusal } from './http-answers';
import {
  ActivityBody,
  activityBody,
  AreaPolicyChangeBody,
  areaPolicyChangeBody,
  BadgeBody,
  badgeBody,
  BulkApproveBody,
  bulkApproveBody,
  BulkApproveMatchingBody,
  bulkApproveMatchingBody,
  BulkApproveMatchingRequest,
  BulkApproveRequest,
  ChangeAreaPolicyRequest,
  ChangeDueDaysRequest,
  CommentRequest,
  DueDaysChangeBody,
  dueDaysChangeBody,
  PolicyBody,
  policyBody,
  ReasonRequest,
  RequestBody,
  requestBody,
  RequestDetailBody,
  requestDetailBody,
  RequestListBody,
  requestListBody,
} from './system-requests.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const REQUEST_PARAM = { name: 'requestId', format: 'uuid', description: 'The system request.' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const HIGH_STEP_UP =
  'A high-risk request needs a fresh two-step proof for `system-requests.request.decide-high` ' +
  '(answered second-factor.required with details.actionKey when missing).';

function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  // Ids and codes only: never a note, a reason, a comment or a value of the change.
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * Admin Inbox › System requests and Settings › People › Review policy (owner decisions of
 * 15 Nov 2026). Thin adapters: the acting admin comes from the session. Every answer is
 * `Cache-Control: no-store`.
 */
@ApiTags('system-requests')
@RoutePopulation('admin')
@ReadsSession()
@Controller('system-requests/admin')
export class SystemRequestsController {
  readonly #logger = new Logger('SystemRequestsController');

  constructor(
    private readonly list: ListSystemRequests,
    private readonly counts: CountSystemRequests,
    private readonly view: ViewSystemRequest,
    private readonly comment: CommentOnSystemRequest,
    private readonly approve: ApproveSystemRequest,
    private readonly approveMany: ApproveSystemRequests,
    private readonly approveMatching: ApproveMatchingSystemRequests,
    private readonly reject: RejectSystemRequest,
    private readonly withdraw: WithdrawSystemRequest,
    private readonly viewPolicy: ViewReviewPolicy,
    private readonly changeArea: ChangeAreaReviewPolicy,
    private readonly changeDueDays: ChangeReviewDueDays,
  ) {}

  @Get('requests')
  @ApiOperation({
    summary: 'One page of the System requests list, every view count and the row actions (admin)',
    description:
      'Needs system-requests.request.view. `view` is a tab: needs-my-review (open, in an area ' +
      'whose review key the caller holds, not their own), all-open (default), mine, approved, ' +
      'reverted, overdue or all. `q` is an SR number (SR-1042 or 1042) or a part of the note, ' +
      'subject kind or subject key. Filters (comma lists): area, risk, status; requestedBy, ' +
      'decidedBy (account ids); appliedFrom and appliedTo (ISO instants, to exclusive); overdue ' +
      '(true); subjectKind and subjectRef (the setting page banner). `sort` is applied (default), ' +
      'due or number; `direction` asc (default) or desc. With `page` (1 or more, row 10,000 at ' +
      'most) the answer has page numbers and a total; without it, `cursor` pages forward ' +
      "(nextCursor), as the Market's List paging setting picks. `pageSize` 1 to 100 (default " +
      '25). `counts` holds every view for the same search and filters. Each row lists the ' +
      "caller's actions (open, copy-link, approve, reject, withdraw).",
  })
  @ApiQuery({ name: 'view', required: false, enum: REQUEST_VIEWS })
  @ApiQuery({ name: 'q', required: false, description: 'Up to 100 characters.' })
  @ApiQuery({
    name: 'area',
    required: false,
    description: `Comma list of ${REVIEW_AREAS.join(', ')}.`,
  })
  @ApiQuery({ name: 'risk', required: false, description: `Comma list of ${RISKS.join(', ')}.` })
  @ApiQuery({
    name: 'status',
    required: false,
    description: `Comma list of ${REQUEST_STATUSES.join(', ')}.`,
  })
  @ApiQuery({ name: 'requestedBy', required: false, description: 'An admin account id.' })
  @ApiQuery({ name: 'decidedBy', required: false, description: 'An admin account id.' })
  @ApiQuery({ name: 'appliedFrom', required: false, description: 'ISO 8601 instant.' })
  @ApiQuery({ name: 'appliedTo', required: false, description: 'ISO 8601 instant (exclusive).' })
  @ApiQuery({ name: 'overdue', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'subjectKind', required: false })
  @ApiQuery({ name: 'subjectRef', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['applied', 'due', 'number'] })
  @ApiQuery({ name: 'direction', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false, description: 'Page mode: from 1.' })
  @ApiQuery({ name: 'pageSize', required: false, description: '1 to 100, default 25.' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor mode: the last nextCursor.' })
  @ApiOkResponse({ type: RequestListBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async requests(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, query);
    logRoute(
      this.#logger,
      'system-requests.list-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return requestListBody(result.value);
  }

  @Get('requests-count')
  @ApiOperation({
    summary: 'The menu badge: requests waiting for the caller, and overdue ones (admin)',
    description:
      'Needs system-requests.request.view. needsMyReview counts open requests in the areas ' +
      "whose review key the caller holds, not the caller's own; overdue counts every open " +
      'request past its review date.',
  })
  @ApiOkResponse({ type: BadgeBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async badge(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.counts.execute(context, {});
    logRoute(
      this.#logger,
      'system-requests.count-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return badgeBody(result.value);
  }

  @Get('requests/:requestId')
  @ApiOperation({
    summary: 'One system request with its values before and after and its history (admin)',
    description: "Needs system-requests.request.view. `actions` are the caller's actions.",
  })
  @ApiParam(REQUEST_PARAM)
  @ApiOkResponse({ type: RequestDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'system-requests.not-found' })
  async request(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { requestId });
    logRoute(
      this.#logger,
      'system-requests.view-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return requestDetailBody(result.value);
  }

  @Post('requests/:requestId/comments')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Comment on a system request (admin)',
    description:
      'Needs system-requests.request.view; any status. body: 1 to 2000 characters. No ' +
      'decision. Refused in an acting-as session. Audited (without the text).',
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiBody({ type: CommentRequest })
  @ApiCreatedResponse({ type: ActivityBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'system-requests.not-found' })
  async addComment(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, ['body']);
    if (invalid !== null) throw invalid;
    const { body } = requestBody_ as { body?: unknown };
    const result = await this.comment.execute(context, { requestId, body });
    logRoute(
      this.#logger,
      'system-requests.comment-route',
      context,
      result.ok ? 'commented' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return activityBody(result.value);
  }

  @Post('requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: "Approve another admin's change (admin, maker-checker)",
    description:
      "Needs system-requests.request.view and the area's review key. The author cannot " +
      `approve. The change stays live. ${HIGH_STEP_UP} No body is read. Refused in an ` +
      'acting-as session. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiOkResponse({ type: RequestBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, system-requests.not-reviewer, system-requests.own-request, ' +
      'second-factor.required or second-factor.enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'system-requests.not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'system-requests.decided' })
  async approveRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.approve.execute(context, { requestId });
    logRoute(
      this.#logger,
      'system-requests.approve-route',
      context,
      result.ok ? 'approved' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return requestBody(result.value);
  }

  @Post('requests/bulk-approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve several low-risk requests at once (admin)',
    description:
      'Needs system-requests.request.view and, per request, its area review key. 1 to 100 ' +
      'distinct ids; each is decided on its own and answered with approved or its refusal ' +
      '(system-requests.not-low-risk for medium and high, which are reviewed one by one). ' +
      'Refused in an acting-as session. Audited per request.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkApproveRequest })
  @ApiOkResponse({ type: BulkApproveBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  async bulkApprove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, ['requestIds']);
    if (invalid !== null) throw invalid;
    const { requestIds } = requestBody_ as { requestIds?: unknown };
    const result = await this.approveMany.execute(context, { requestIds });
    logRoute(
      this.#logger,
      'system-requests.bulk-approve-route',
      context,
      result.ok ? 'decided' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return bulkApproveBody(result.value);
  }

  @Post('requests/bulk-approve-matching')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve every low-risk request that matches the list (admin, select all matching)',
    description:
      'Needs system-requests.request.view and, per request, its area review key. The body ' +
      'holds the same view, search and filters as GET requests (strings, as in the query; no ' +
      'page, cursor or sort). Approves only open low-risk requests in an area whose review key ' +
      "the caller holds, never the caller's own: at most 100 per call, oldest SR number first, " +
      'each decided in its own unit (failed lists the refusal code of each one decided in ' +
      'between). remaining is how many such requests still match: the panel calls again while ' +
      'it is above 0 and the last call approved at least one. Refused in an acting-as session. ' +
      'Audited per request.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: BulkApproveMatchingRequest })
  @ApiOkResponse({ type: BulkApproveMatchingBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  async bulkApproveMatching(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, [...MATCHING_FIELDS]);
    if (invalid !== null) throw invalid;
    const result = await this.approveMatching.execute(
      context,
      requestBody_ as Record<string, unknown>,
    );
    logRoute(
      this.#logger,
      'system-requests.bulk-approve-matching-route',
      context,
      result.ok ? 'decided' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return bulkApproveMatchingBody(result.value);
  }

  @Post('requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject another admin's change and restore the value before (admin, maker-checker)",
    description:
      "Needs system-requests.request.view and the area's review key; reason 1 to 500 " +
      'characters. The author cannot reject. The owning module restores the value before only ' +
      'when the subject still holds the value after the change and no later request exists ' +
      '(else 409 system-requests.changed-since, details.newerRequestId). Effects of the change ' +
      `in between are not undone. ${HIGH_STEP_UP} Refused in an acting-as session. Audited.`,
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiBody({ type: ReasonRequest })
  @ApiOkResponse({ type: RequestBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, system-requests.not-reviewer, system-requests.own-request, ' +
      'system-requests.revert-not-permitted, second-factor.required or ' +
      'second-factor.enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'system-requests.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'system-requests.decided, system-requests.changed-since or system-requests.subject-gone',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'system-requests.revert-unavailable' })
  async rejectRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, ['reason']);
    if (invalid !== null) throw invalid;
    const { reason } = requestBody_ as { reason?: unknown };
    const result = await this.reject.execute(context, { requestId, reason });
    logRoute(
      this.#logger,
      'system-requests.reject-route',
      context,
      result.ok ? 'reverted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return requestBody(result.value);
  }

  @Post('requests/:requestId/withdraw')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revert my own change (admin, author only)',
    description:
      'Needs system-requests.request.view; only the author; reason 1 to 500 characters. The ' +
      'value before is restored on the same terms as a reject. ' +
      `${HIGH_STEP_UP} Refused in an acting-as session. Audited.`,
  })
  @ApiHeader(CSRF)
  @ApiParam(REQUEST_PARAM)
  @ApiBody({ type: ReasonRequest })
  @ApiOkResponse({ type: RequestBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, system-requests.not-author, ' +
      'system-requests.revert-not-permitted, second-factor.required or ' +
      'second-factor.enrolment-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'system-requests.not-found' })
  @ApiConflictResponse({
    ...ERROR,
    description:
      'system-requests.decided, system-requests.changed-since or system-requests.subject-gone',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'system-requests.revert-unavailable' })
  async withdrawRequest(
    @Call() context: CallContext,
    @Param('requestId') requestId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, ['reason']);
    if (invalid !== null) throw invalid;
    const { reason } = requestBody_ as { reason?: unknown };
    const result = await this.withdraw.execute(context, { requestId, reason });
    logRoute(
      this.#logger,
      'system-requests.withdraw-route',
      context,
      result.ok ? 'reverted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return requestBody(result.value);
  }

  @Get('review-policy')
  @ApiOperation({
    summary: 'The review policy of the Market (admin)',
    description:
      'Needs system-requests.policy.view. Per area: reviewed or not, default risk, the review ' +
      'key and the version (0 while the default is in force); the review period in days; and ' +
      'the review policy itself (always reviewed, high risk).',
  })
  @ApiOkResponse({ type: PolicyBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async policy(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.viewPolicy.execute(context, {});
    logRoute(
      this.#logger,
      'system-requests.view-policy-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return policyBody(result.value);
  }

  @Put('review-policy/areas/:area')
  @HttpCode(200)
  @RequiresStepUp('system-requests.policy.change')
  @ApiOperation({
    summary: "Change an area's review policy (admin)",
    description:
      'Needs system-requests.policy.manage (protected) and a fresh two-step proof for ' +
      '`system-requests.policy.change`. Turns review on or off and sets the default risk; ' +
      'note (1 to 500 characters) is required and shown to the reviewer. The change goes live ' +
      'and opens a high-risk review request (area review-policy). A stale expectedVersion is ' +
      '409 system-requests.policy-conflict; the value in force changes nothing. Refused in an ' +
      'acting-as session. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'area', enum: POLICY_AREAS })
  @ApiBody({ type: ChangeAreaPolicyRequest })
  @ApiOkResponse({ type: AreaPolicyChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required or second-factor.enrolment-required',
  })
  @ApiConflictResponse({ ...ERROR, description: 'system-requests.policy-conflict' })
  async putAreaPolicy(
    @Call() context: CallContext,
    @Param('area') area: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, [
      'enabled',
      'risk',
      'expectedVersion',
      'note',
    ]);
    if (invalid !== null) throw invalid;
    const { enabled, risk, expectedVersion, note } = requestBody_ as Record<string, unknown>;
    const result = await this.changeArea.execute(context, {
      area,
      enabled,
      risk,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'system-requests.change-area-policy-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return areaPolicyChangeBody(result.value);
  }

  @Put('review-policy/review-due-days')
  @HttpCode(200)
  @RequiresStepUp('system-requests.policy.change')
  @ApiOperation({
    summary: 'Change after how many days an open request is overdue (admin)',
    description:
      'Needs system-requests.policy.manage (protected) and a fresh two-step proof for ' +
      '`system-requests.policy.change`. reviewDueDays 1 to 90; note required. Applies to ' +
      'requests opened from now on. Reviewed as high risk, like every policy change. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ChangeDueDaysRequest })
  @ApiOkResponse({ type: DueDaysChangeBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, request.csrf, second-factor.required or second-factor.enrolment-required',
  })
  @ApiConflictResponse({ ...ERROR, description: 'system-requests.policy-conflict' })
  async putDueDays(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody_: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody_, ['reviewDueDays', 'expectedVersion', 'note']);
    if (invalid !== null) throw invalid;
    const { reviewDueDays, expectedVersion, note } = requestBody_ as Record<string, unknown>;
    const result = await this.changeDueDays.execute(context, {
      reviewDueDays,
      expectedVersion,
      note,
    });
    logRoute(
      this.#logger,
      'system-requests.change-due-days-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return dueDaysChangeBody(result.value);
  }
}
