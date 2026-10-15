import { Body, Controller, Get, HttpCode, Logger, Put, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
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
import { SetSupportContact } from '../application/use-cases/set-support-contact.use-case';
import { ViewSupportContact } from '../application/use-cases/view-support-contact.use-case';
import { closedBody, refusal } from './http-answers';
import { SetSupportContactRequest, SupportContactBody } from './support-contact.dto';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

/**
 * The Market's support email address, read and set by an admin. Thin adapters: each use case
 * does its work behind its gate. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('notifications')
@RoutePopulation('admin')
@ReadsSession()
@Controller('notifications/admin/support-contact')
export class AdminSupportContactController {
  readonly #logger = new Logger('AdminSupportContactController');

  constructor(
    private readonly view: ViewSupportContact,
    private readonly set: SetSupportContact,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The support email address (admin)',
    description:
      'Needs notifications.support-contact.view. email is the Market default until an admin changes it.',
  })
  @ApiOkResponse({ type: SupportContactBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  async one(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    this.log(
      'notifications.view-support-contact-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the support email address (admin)',
    description:
      'Needs notifications.support-contact.manage (protected). expectedVersion is the version the screen read; ' +
      'a different current version answers notifications.conflict. The same address again changes ' +
      'nothing. Every change is a new version in an insert-only history and an audit row.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: SetSupportContactRequest })
  @ApiOkResponse({ type: SupportContactBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiConflictResponse({
    ...ERROR,
    description: 'notifications.conflict (another admin changed it first)',
  })
  async put(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, ['email', 'expectedVersion']);
    if (invalid !== null) throw invalid;
    const { email, expectedVersion } = requestBody as {
      email?: unknown;
      expectedVersion?: unknown;
    };
    const result = await this.set.execute(context, { email, expectedVersion });
    this.log(
      'notifications.set-support-contact-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
