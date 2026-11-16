import { Body, Controller, Get, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
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
import { AdminCustomerAssistantConversationsSection } from '../application/use-cases/admin-customer-assistant-conversations.use-case';
import { AdminCustomerAssistantConversationsSectionExport } from '../application/use-cases/admin-customer-assistant-conversations-export.use-case';
import { AdminCustomerBehaviourSection } from '../application/use-cases/admin-customer-behaviour.use-case';
import { AdminCustomerCartAdditionsSection } from '../application/use-cases/admin-customer-cart-additions.use-case';
import { AdminCustomerCartAdditionsSectionExport } from '../application/use-cases/admin-customer-cart-additions-export.use-case';
import { AdminCustomerCartRemindersSection } from '../application/use-cases/admin-customer-cart-reminders.use-case';
import { AdminCustomerCartRemindersSectionExport } from '../application/use-cases/admin-customer-cart-reminders-export.use-case';
import { AdminCustomerCartSection } from '../application/use-cases/admin-customer-cart.use-case';
import { AdminCustomerConsentHistorySection } from '../application/use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsentHistorySectionExport } from '../application/use-cases/admin-customer-consent-history-export.use-case';
import { AdminCustomerConsentSection } from '../application/use-cases/admin-customer-consent.use-case';
import { AdminCustomerSavedItemsSection } from '../application/use-cases/admin-customer-saved-items.use-case';
import { AdminCustomerSavedItemsSectionExport } from '../application/use-cases/admin-customer-saved-items-export.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import {
  CSRF,
  ERROR,
  EXPORT,
  exportRoute,
  INSTANTS,
  listRoute,
  NOT_FOUND,
  PAGING,
  readRoute,
  UNAUTHORIZED,
} from './section-routes';

/**
 * The customer page's shopping and privacy sections (customers management phase 2b), one route
 * per section, each read lazily when the panel opens it: the cart and saved-for-later list (cart),
 * the abandoned-cart reminders sent (notifications), the behaviour summary and add-to-cart history
 * (engagement), the marketing consent and its history (legal) and the count and dates of assistant
 * conversations (assistant). Every list is a super list with its export. Every answer is
 * `Cache-Control: no-store`; a POST needs the CSRF token. Each route needs
 * `customers.customers.view` and the owner's own key, which the owner checks again.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/customers')
export class AdminCustomerActivityController {
  readonly #logger = new Logger('AdminCustomerActivityController');

  constructor(
    private readonly savedItems: AdminCustomerSavedItemsSection,
    private readonly savedItemsExport: AdminCustomerSavedItemsSectionExport,
    private readonly cartReminders: AdminCustomerCartRemindersSection,
    private readonly cartRemindersExport: AdminCustomerCartRemindersSectionExport,
    private readonly cartAdditions: AdminCustomerCartAdditionsSection,
    private readonly cartAdditionsExport: AdminCustomerCartAdditionsSectionExport,
    private readonly consentHistory: AdminCustomerConsentHistorySection,
    private readonly consentHistoryExport: AdminCustomerConsentHistorySectionExport,
    private readonly assistantConversations: AdminCustomerAssistantConversationsSection,
    private readonly assistantConversationsExport: AdminCustomerAssistantConversationsSectionExport,
    private readonly cartRead: AdminCustomerCartSection,
    private readonly behaviourRead: AdminCustomerBehaviourSection,
    private readonly consentRead: AdminCustomerConsentSection,
  ) {}

  @Get(':accountId/cart')
  @ApiOperation({
    summary: 'A customer’s current cart (admin)',
    description:
      'Needs customers.customers.view and cart.customer-cart.view. The active cart (null when ' +
      'there is none): when created and last changed, and each line’s offer and variant ids, ' +
      'quantity, the price when added (`amount` in minor units as a string, `currency`) and when ' +
      'added; `savedCount` is the saved-for-later count.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  readCart(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    return readRoute(this.#logger, context, response, accountId, (input) =>
      this.cartRead.execute(context, input),
    );
  }

  @Get(':accountId/behaviour')
  @ApiOperation({
    summary: 'A customer’s personalization switch and behaviour summary (admin)',
    description:
      'Needs customers.customers.view and engagement.customer-behaviour.view. `personalization` ' +
      '(enabled, changedAt) and `summary` over the 12 months kept: productViews, categoryViews, ' +
      'cartAdditions and the ten most viewed categories (ids and counts). Never the search text.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  readBehaviour(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    return readRoute(this.#logger, context, response, accountId, (input) =>
      this.behaviourRead.execute(context, input),
    );
  }

  @Get(':accountId/consent')
  @ApiOperation({
    summary: 'A customer’s current marketing consent (admin)',
    description:
      'Needs customers.customers.view and legal.customer-consent.view. One entry per channel: ' +
      'granted (false until the customer agreed), the source and when it last changed. Read only.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  readConsent(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    return readRoute(this.#logger, context, response, accountId, (input) =>
      this.consentRead.execute(context, input),
    );
  }

  @Post(':accountId/saved-items')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A customer’s saved-for-later list (super list, admin)',
    description:
      'Needs customers.customers.view and cart.customer-cart.view. Body: no `filters`, `sort` ' +
      `(saved), ${PAGING}. Each row: the saved item, offer and variant ids and when it was ` +
      'saved. An account holds at most 100.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listSavedItems(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.savedItems.execute(context, input),
    );
  }

  @Post(':accountId/saved-items/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export a customer’s saved-for-later list as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs cart.customer-cart.view.`,
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
  async exportSavedItems(
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
      'saved-items',
      (input) => this.savedItemsExport.execute(context, input),
    );
  }

  @Post(':accountId/cart-reminders')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The abandoned-cart reminders a customer was sent (super list, admin)',
    description:
      'Needs customers.customers.view and notifications.customer-cart-reminder.view. Body: no ' +
      `\`filters\`, \`sort\` (sent), ${PAGING}. Each row: \`sentAt\`, when notifications took the ` +
      'stage for sending (not proof of delivery: a send that then failed or was skipped keeps it, ' +
      'and the stage is not retried), the stage (1 or 2) and the cart change it was about. ' +
      'notifications keeps them 30 days; no mail content.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listCartReminders(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.cartReminders.execute(context, input),
    );
  }

  @Post(':accountId/cart-reminders/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary:
      'Export the abandoned-cart reminders a customer was sent as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs notifications.customer-cart-reminder.view.`,
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
  async exportCartReminders(
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
      'cart-reminders',
      (input) => this.cartRemindersExport.execute(context, input),
    );
  }

  @Post(':accountId/cart-additions')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A customer’s add-to-cart history (super list, admin)',
    description:
      'Needs customers.customers.view and engagement.customer-behaviour.view. Body: `filters` ' +
      `(${INSTANTS}), \`sort\` (added), ${PAGING}. Each row: when, the offer and variant ids. ` +
      'engagement keeps 12 months, and nothing while the customer has personalization off.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listCartAdditions(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.cartAdditions.execute(context, input),
    );
  }

  @Post(':accountId/cart-additions/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export a customer’s add-to-cart history as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs engagement.customer-behaviour.view.`,
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
  async exportCartAdditions(
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
      'cart-additions',
      (input) => this.cartAdditionsExport.execute(context, input),
    );
  }

  @Post(':accountId/consent-history')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The changes of a customer’s marketing consent (super list, admin)',
    description:
      'Needs customers.customers.view and legal.customer-consent.view. Body: `filters` ' +
      `(\`channel\`: an array of email), \`sort\` (occurred), ${PAGING}. Each row: when, the ` +
      'channel, granted or withdrawn and the source (sign-up, account, unsubscribe-link). Read only.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listConsentHistory(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.consentHistory.execute(context, input),
    );
  }

  @Post(':accountId/consent-history/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the changes of a customer’s marketing consent as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs legal.customer-consent.view.`,
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
  async exportConsentHistory(
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
      'consent-history',
      (input) => this.consentHistoryExport.execute(context, input),
    );
  }

  @Post(':accountId/assistant-conversations')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The count and dates of a customer’s assistant conversations (super list, admin)',
    description:
      'Needs customers.customers.view and assistant.customer-conversation.view. Body: no ' +
      `\`filters\`, \`sort\` (started), ${PAGING}. Each row: when it started and its last ` +
      'message; `conversationCount` beside every page. Never a message, card or turn count.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listAssistantConversations(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return listRoute(this.#logger, context, request, response, accountId, body, (input) =>
      this.assistantConversations.execute(context, input),
    );
  }

  @Post(':accountId/assistant-conversations/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary:
      'Export the count and dates of a customer’s assistant conversations as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs assistant.customer-conversation.view. Dates only.`,
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
  async exportAssistantConversations(
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
      'assistant-conversations',
      (input) => this.assistantConversationsExport.execute(context, input),
    );
  }
}
