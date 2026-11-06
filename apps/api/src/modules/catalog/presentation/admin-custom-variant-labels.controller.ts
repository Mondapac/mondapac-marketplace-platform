import { Controller, Get, Header, HttpException, Logger, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminCustomVariantLabels } from '../application/use-cases/admin-custom-variant-labels.use-case';
import { CustomVariantLabelsDto } from './admin-custom-variant-labels.dto';
import { refusalWith } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';

/** The HTTP status of each refusal of the report. */
export const ADMIN_CUSTOM_VARIANT_LABELS_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'access.unavailable': 503,
});

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NUMBER = /^\d{1,4}$/;

/**
 * The read-only "Custom variant labels" report (variants V2): variants of published revisions
 * whose stored label differs from the automatic one. A thin adapter over one use case.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin/custom-variant-labels')
export class AdminCustomVariantLabelsController {
  readonly #logger = new Logger('AdminCustomVariantLabelsController');

  constructor(private readonly report: AdminCustomVariantLabels) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List variants whose stored label is not the automatic one',
    description:
      'Needs catalog.product.view. Variants of published revisions whose stored label differs ' +
      'from the label built from their option labels, per locale (stored and built). Paged by ' +
      'afterId (a variant id from nextAfterId) and limit (1 to 100, default 50). Read-only: no ' +
      'revision is rewritten.',
  })
  @ApiQuery({ name: 'afterId', required: false, description: 'nextAfterId of the last page.' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 100, default 50.' })
  @ApiOkResponse({ type: CustomVariantLabelsDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<CustomVariantLabelsDto> {
    const input: Record<string, unknown> = { ...query };
    const limit = input['limit'];
    if (limit !== undefined) {
      input['limit'] = typeof limit === 'string' && NUMBER.test(limit) ? Number(limit) : -1;
    }
    const result = await this.report.execute(context, input);
    const outcome = result.ok
      ? (JSON.parse(JSON.stringify(result.value)) as CustomVariantLabelsDto)
      : refusalWith(ADMIN_CUSTOM_VARIANT_LABELS_STATUS, result.error, response, context);
    const failed = !result.ok && result.error.code === 'access.unavailable';
    this.#logger[failed ? 'warn' : 'log']({
      msg: 'catalog.admin-custom-variant-labels',
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
