import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminCustomerReviewsSection } from '../application/use-cases/admin-customer-reviews.use-case';
import { AdminCustomerReviewsSectionExport } from '../application/use-cases/admin-customer-reviews-export.use-case';
import { AdminCustomerSellerRatingsSection } from '../application/use-cases/admin-customer-seller-ratings.use-case';
import { AdminCustomerSellerRatingsSectionExport } from '../application/use-cases/admin-customer-seller-ratings-export.use-case';
import { AdminCustomerHelpfulVotesSection } from '../application/use-cases/admin-customer-helpful-votes.use-case';
import { AdminCustomerHelpfulVotesSectionExport } from '../application/use-cases/admin-customer-helpful-votes-export.use-case';
import { AdminCustomerReviewReportsSection } from '../application/use-cases/admin-customer-review-reports.use-case';
import { AdminCustomerReviewReportsSectionExport } from '../application/use-cases/admin-customer-review-reports-export.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import {
  CSRF,
  ERROR,
  EXPORT,
  exportRoute,
  listRoute,
  NOT_FOUND,
  PAGING,
  UNAUTHORIZED,
} from './section-routes';

/**
 * The customer page's reviews sections (customers management phase 2b, part 3), one route per
 * section, each read lazily when the panel opens it: the reviews the customer wrote with their
 * status and moderation state, the seller ratings they gave, the helpful votes they cast and the
 * reports by and about them, all from reviews' facade. Read only: moderating stays in the
 * moderation queue. Every list is a super list with its export. Every answer is
 * `Cache-Control: no-store`; a POST needs the CSRF token. Each route needs
 * `customers.customers.view` and `reviews.customer-review.view`, which reviews checks again for a
 * platform admin not acting as anyone.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/customers')
export class AdminCustomerReviewsController {
  readonly #logger = new Logger('AdminCustomerReviewsController');

  constructor(
    private readonly reviews: AdminCustomerReviewsSection,
    private readonly reviewsExport: AdminCustomerReviewsSectionExport,
    private readonly sellerRatings: AdminCustomerSellerRatingsSection,
    private readonly sellerRatingsExport: AdminCustomerSellerRatingsSectionExport,
    private readonly helpfulVotes: AdminCustomerHelpfulVotesSection,
    private readonly helpfulVotesExport: AdminCustomerHelpfulVotesSectionExport,
    private readonly reviewReports: AdminCustomerReviewReportsSection,
    private readonly reviewReportsExport: AdminCustomerReviewReportsSectionExport,
  ) {}

  @Post(':accountId/reviews')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The reviews a customer wrote (super list, admin)',
    description:
      'Needs customers.customers.view and reviews.customer-review.view. ' +
      `Body: \`filters\` (\`status\`: an array of published, held, hidden, removed, deleted-by-author), \`sort\` (created), ${PAGING}. Each row: the review, product, offer and seller ids, the rating, anonymous, the status, when created, edited and published, the helpful votes, the open reports and the latest moderation line (action, reason code, whether a moderator did it, when). Never the title or the text. Read only: moderating stays in the moderation queue.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listReviews(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.reviews.execute(context, input),
    );
  }

  @Post(':accountId/reviews/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the reviews a customer wrote as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs reviews.customer-review.view. Ids, codes and instants only.`,
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
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportReviews(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await exportRoute(
      this.#logger,
      context,
      request,
      response,
      accountId,
      body,
      'reviews',
      (input) => this.reviewsExport.execute(context, input),
    );
  }

  @Post(':accountId/seller-ratings')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The seller ratings a customer gave (super list, admin)',
    description:
      'Needs customers.customers.view and reviews.customer-review.view. ' +
      `Body: \`filters\` (\`status\`: an array of published, hidden, removed), \`sort\` (created), ${PAGING}. Each row: the rating, seller and seller order ids, satisfaction, as described, arrived OK, the reason code, the status and when.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listSellerRatings(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.sellerRatings.execute(context, input),
    );
  }

  @Post(':accountId/seller-ratings/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the seller ratings a customer gave as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs reviews.customer-review.view. Ids, codes and instants only.`,
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
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportSellerRatings(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await exportRoute(
      this.#logger,
      context,
      request,
      response,
      accountId,
      body,
      'seller-ratings',
      (input) => this.sellerRatingsExport.execute(context, input),
    );
  }

  @Post(':accountId/helpful-votes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The helpful votes a customer cast (super list, admin)',
    description:
      'Needs customers.customers.view and reviews.customer-review.view. ' +
      `Body: no \`filters\`, \`sort\` (voted), ${PAGING}. Each row: the review and product voted for and when. Never the review's author.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listHelpfulVotes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.helpfulVotes.execute(context, input),
    );
  }

  @Post(':accountId/helpful-votes/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the helpful votes a customer cast as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs reviews.customer-review.view. Never the review's author.`,
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
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportHelpfulVotes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await exportRoute(
      this.#logger,
      context,
      request,
      response,
      accountId,
      body,
      'helpful-votes',
      (input) => this.helpfulVotesExport.execute(context, input),
    );
  }

  @Post(':accountId/review-reports')
  @HttpCode(200)
  @ApiOperation({
    summary: "The reports made by a customer and about a customer's reviews (super list, admin)",
    description:
      'Needs customers.customers.view and reviews.customer-review.view. ' +
      `Body: \`filters\` (\`role\`: an array of by, about), \`sort\` (created), ${PAGING}. Each row: the report and review ids, the role (by: the customer made it; about: it reports one of the customer's reviews), the reason code, the status and when. Never the reporter.`,
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listReviewReports(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.reviewReports.execute(context, input),
    );
  }

  @Post(':accountId/review-reports/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary:
      "Export the reports made by a customer and about a customer's reviews as a CSV or XLSX file (admin)",
    description: `${EXPORT} Needs reviews.customer-review.view. Never the reporter.`,
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
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportReviewReports(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await exportRoute(
      this.#logger,
      context,
      request,
      response,
      accountId,
      body,
      'review-reports',
      (input) => this.reviewReportsExport.execute(context, input),
    );
  }
}
