import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AcknowledgeSecurityAlert } from '../application/use-cases/acknowledge-security-alert.use-case';
import { ListSecurityAlerts } from '../application/use-cases/list-security-alerts.use-case';
import { ResolveSecurityAlert } from '../application/use-cases/resolve-security-alert.use-case';
import { ViewOnCall } from '../application/use-cases/view-on-call.use-case';
import { ViewSecurityAlert } from '../application/use-cases/view-security-alert.use-case';
import { ViewSecuritySummary } from '../application/use-cases/view-security-summary.use-case';
import { closedBody, refusal } from './http-answers';
import {
  AcknowledgeAlertRequest,
  AlertDetailBody,
  alertDetailBody,
  AlertPageBody,
  alertPageBody,
  OnCallBody,
  onCallBody,
  ResolveAlertRequest,
  SummaryBody,
  summaryBody,
} from './security.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The security centre's API for admins (SOC package 2): the summary, the alerts and their
 * timeline, the on-call view, and acknowledging and resolving. Every answer is
 * `Cache-Control: no-store`. Logs ids and codes only; never a key, a note or an address.
 */
@ApiTags('security')
@RoutePopulation('admin')
@ReadsSession()
@Controller('security/admin')
export class AdminSecurityController {
  readonly #logger = new Logger('AdminSecurityController');

  constructor(
    private readonly summary: ViewSecuritySummary,
    private readonly list: ListSecurityAlerts,
    private readonly view: ViewSecurityAlert,
    private readonly onCall: ViewOnCall,
    private readonly acknowledgeAlert: AcknowledgeSecurityAlert,
    private readonly resolveAlert: ResolveSecurityAlert,
  ) {}

  #log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  @Get('summary')
  @ApiOperation({
    summary: 'The top of the security centre (admin)',
    description:
      'Needs security.centre.view. Live (open or acknowledged) alerts by severity, when the rules last ' +
      'ran, and who is on call now (null without a roster).',
  })
  @ApiOkResponse({ type: SummaryBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async getSummary(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.summary.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return summaryBody(result.value);
  }

  @Get('alerts')
  @ApiOperation({
    summary: 'The alerts of the Market (admin)',
    description:
      'Needs security.centre.view. By severity (s1 first), newest first. state and severity are ' +
      "comma-separated filters; after is the previous page's next cursor; limit 1 to 100 " +
      '(default 50). An address key is masked here; the alert itself shows it.',
  })
  @ApiQuery({ name: 'state', required: false, description: 'open,acknowledged,resolved' })
  @ApiQuery({ name: 'severity', required: false, description: 's1,s2,s3,s4' })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: AlertPageBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async getAlerts(
    @Call() context: CallContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const { state, severity, after, limit } = query;
    const result = await this.list.execute(context, { state, severity, after, limit });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return alertPageBody(result.value);
  }

  @Get('alerts/:alertId')
  @ApiOperation({
    summary: 'One alert with its delivery timeline (admin)',
    description:
      'Needs security.centre.view. The key in full, the resolution and every message sent.',
  })
  @ApiOkResponse({ type: AlertDetailBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: 'security.alert-not-found' })
  async getAlert(
    @Call() context: CallContext,
    @Param('alertId') alertId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { alertId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return alertDetailBody(result.value);
  }

  @Get('on-call')
  @ApiOperation({
    summary: 'The on-call view (admin)',
    description:
      'Needs security.centre.view. Who is on call, the s1 escalation order, this week and the next ' +
      'three, and the channels by severity. Names only; the roster file is server configuration.',
  })
  @ApiOkResponse({ type: OnCallBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async getOnCall(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.onCall.execute(context, {});
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return onCallBody(result.value);
  }

  @Post('alerts/:alertId/acknowledge')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Acknowledge an open alert (admin)',
    description:
      'Needs security.alerts.respond; refused in an acting-as session. Stops the escalation. The body ' +
      'carries the version the responder saw: a stale act is 409 security.conflict; an alert that ' +
      'is not open is 409 security.alert-state. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AcknowledgeAlertRequest })
  @ApiOkResponse({ type: AlertDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'security.alert-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'security.conflict or security.alert-state' })
  async postAcknowledge(
    @Call() context: CallContext,
    @Param('alertId') alertId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion']);
    if (invalid !== null) throw invalid;
    const { expectedVersion } = requestBody as { expectedVersion?: unknown };
    const result = await this.acknowledgeAlert.execute(context, { alertId, expectedVersion });
    this.#log(
      'security.acknowledge-alert-route',
      context,
      result.ok ? 'acknowledged' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return alertDetailBody(result.value);
  }

  @Post('alerts/:alertId/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve an alert (admin)',
    description:
      'Needs security.alerts.respond; refused in an acting-as session. An s1 alert only by the ' +
      'incident commander or the security owner of the on-call roster (403 ' +
      'security.s1-resolver-only). The outcome and a note of 10 to 1000 characters are required; ' +
      'the note is shown on the alert and never logged. Stale version: 409 security.conflict. Audited.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: ResolveAlertRequest })
  @ApiOkResponse({ type: AlertDetailBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, request.csrf or security.s1-resolver-only',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'security.alert-not-found' })
  @ApiConflictResponse({ ...ERROR, description: 'security.conflict or security.alert-state' })
  async postResolve(
    @Call() context: CallContext,
    @Param('alertId') alertId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['expectedVersion', 'resolution', 'note']);
    if (invalid !== null) throw invalid;
    const { expectedVersion, resolution, note } = requestBody as {
      expectedVersion?: unknown;
      resolution?: unknown;
      note?: unknown;
    };
    const result = await this.resolveAlert.execute(context, {
      alertId,
      expectedVersion,
      resolution,
      note,
    });
    this.#log('security.resolve-alert-route', context, result.ok ? 'resolved' : result.error.code);
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return alertDetailBody(result.value);
  }
}
