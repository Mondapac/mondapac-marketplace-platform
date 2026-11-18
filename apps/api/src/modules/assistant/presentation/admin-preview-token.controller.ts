import { Controller, HttpCode, Logger, Post, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { IssuePreviewToken } from '../application/use-cases/issue-preview-token.use-case';
import { PreviewTokenBody } from './assistant.dto';
import { refusal } from './http-answers';

const ERROR = { type: Object };

/**
 * The internal preview of the buyer assistant (stage 0, B4): an admin takes a short-lived signed
 * token to the storefront. A thin adapter; the answer is `no-store` and is never logged.
 */
@ApiTags('assistant')
@RoutePopulation('admin')
@ReadsSession()
@Controller('assistant/admin/preview-token')
export class AdminPreviewTokenController {
  readonly #logger = new Logger('AdminPreviewTokenController');

  constructor(private readonly issue: IssuePreviewToken) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'An internal preview token for the storefront (admin)',
    description:
      'Needs assistant.settings.manage (protected). Valid 30 minutes and for this Market only; the ' +
      'storefront sends it as the x-assistant-preview header, and the assistant then answers that ' +
      'browser while the audience is internal (still never while switched off, unconfigured or ' +
      'paused by a spend cap). Each issue is an audit row; the token is never stored or logged. ' +
      'No body.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiOkResponse({ type: PreviewTokenBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({
    ...ERROR,
    description: 'assistant.preview-unavailable (no signing key on this server)',
  })
  async create(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.issue.execute(context, {});
    this.#logger.log({
      msg: 'assistant.issue-preview-token-route',
      outcome: result.ok ? 'issued' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
