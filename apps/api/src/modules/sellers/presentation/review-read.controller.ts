import { Controller, Get, Logger, Param, Res } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
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
import { ReviewRead, type ReviewRevisionView } from '../application/use-cases/review-read.use-case';
import { errorOf } from './my-file.answer';
import { SellersErrorBody } from './my-file.dto';
import { ReviewReadBody, ReviewRevisionBody } from './review-read.dto';

const revisionBody = (view: ReviewRevisionView): ReviewRevisionBody => ({
  ...view,
  createdAt: view.createdAt.toString(),
  registerAtSubmission: {
    ...view.registerAtSubmission,
    checkedAt: view.registerAtSubmission.checkedAt?.toString() ?? null,
  },
});

/**
 * The review page of one seller over HTTP (sellers design 6.2 `review.read`, 8.3; slice 7a-read).
 * A thin adapter: the `CallContext` comes from `@Call()` and the admin session cookie of the
 * request's Market (`@RoutePopulation('admin')` with `@ReadsSession()`); the controller
 * authenticates only. Who may read is the gate of the use case (`sellers.business-details.view`),
 * and the seller id of the path is read with the request's Market, so a seller of another Market
 * is `file.not-found`, byte-identical to an unknown id (AC 1). The answer holds business data in
 * clear, so it is `Cache-Control: no-store`, errors included; the log line holds the outcome only.
 */
@ApiTags('sellers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('sellers/admin')
export class ReviewReadController {
  readonly #logger = new Logger('ReviewReadController');

  constructor(private readonly review: ReviewRead) {}

  @Get(':sellerId/review')
  @ApiOperation({
    summary: 'The review page of a seller (reviewer)',
    description:
      'The revision under review in clear (the pending one, else the latest), the approved ' +
      'revision beside a pending identity change, the access state, and where the business ' +
      'number stands against the register. Each read is audited. Needs ' +
      'sellers.business-details.view.',
  })
  @ApiParam({ name: 'sellerId', description: 'The seller id (UUID).' })
  @ApiOkResponse({ type: ReviewReadBody })
  @ApiUnauthorizedResponse({
    type: SellersErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: SellersErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({
    type: SellersErrorBody,
    description: 'file.not-found (also for an id of another Market or a malformed id)',
  })
  @ApiConflictResponse({
    type: SellersErrorBody,
    description: 'review.no-revision: the seller has submitted nothing yet',
  })
  @ApiServiceUnavailableResponse({
    type: SellersErrorBody,
    description: 'access.unavailable or sellers.unavailable',
  })
  async read(
    @Call() context: CallContext,
    @Param('sellerId') sellerId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReviewReadBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.review.execute(context, { sellerId });
    this.#logger.log({
      msg: 'sellers.review-read-route',
      outcome: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (!result.ok) throw errorOf(result.error, response);
    const view = result.value;
    return {
      sellerId: view.sellerId,
      access: view.access,
      current: revisionBody(view.current),
      previous: view.previous === null ? null : revisionBody(view.previous),
      register: {
        ...view.register,
        checkedAt: view.register.checkedAt?.toString() ?? null,
        manualCheck:
          view.register.manualCheck === null
            ? null
            : {
                observedOutcome: view.register.manualCheck.observedOutcome,
                recordedAt: view.register.manualCheck.recordedAt.toString(),
              },
      },
      decisionInProgress: view.decisionInProgress,
    };
  }
}
