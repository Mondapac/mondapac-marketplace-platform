import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import type { SectionExportFile } from '../application/customer-section-lists';
import { AdminCustomerPasswordReset } from '../application/use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSessions } from '../application/use-cases/admin-customer-sessions.use-case';
import { AdminCustomerSignInReveal } from '../application/use-cases/admin-customer-sign-in-reveal.use-case';
import { AdminCustomerSignInsExport } from '../application/use-cases/admin-customer-sign-ins-export.use-case';
import { AdminCustomerSignIns } from '../application/use-cases/admin-customer-sign-ins.use-case';
import { AdminCustomerSignOut } from '../application/use-cases/admin-customer-sign-out.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { closedBody, fail, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const NOT_FOUND = 'customers.customer-not-found';
const LIST_KEYS = ['filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];
const EXPORT_KEYS = ['format', 'filters', 'sort', 'direction'];
const PAGING =
  '`direction` (desc, the default, or asc), `page`, `pageSize` (at most 100) and `paging` (pages, ' +
  'with the total, or prev-next: the Market’s List paging setting)';
const INSTANTS =
  '`from`, `to`: ISO 8601 instants (the panel turns the admin’s local days into instants)';
const EXPORT =
  'Needs customers.customers.view, the section’s own key and the protected ' +
  `customers.customers.export, and a fresh two-step proof for \`${CUSTOMERS_EXPORT_STEP_UP}\` ` +
  '(spent by the export). Body: `format` (csv, the default, or xlsx), `filters`, `sort` and ' +
  '`direction` as for the list. At most 10,000 rows. Audited ' +
  '(customers.customer-section.exported: the section, format and count).';

type Outcome<T> = Result<T, { readonly code: string } & Record<string, unknown>>;

/** A body that must be absent or `{}` (an action or a reveal takes nothing). */
function emptyBody(body: unknown): HttpException | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    return null;
  }
  return fail(400, 'validation.failed', { fields: [{ path: '', code: 'unknown-field' }] });
}

/**
 * The customer page's sections that other modules own (customers management phase 2b), one route
 * per section, each read lazily when the panel opens it. The security section (identity): the
 * sign-ins of the last 90 days as a super list with its export, the reveal of one sign-in's
 * address, the live sessions, "sign out everywhere" and "send password reset". Every answer is
 * `Cache-Control: no-store`; a POST needs the CSRF token. Each route needs
 * `customers.customers.view` and the owner's own key, which the owner checks again.
 */
@ApiTags('customers')
@RoutePopulation('admin')
@ReadsSession()
@Controller('customers/admin/customers')
export class AdminCustomerSectionsController {
  readonly #logger = new Logger('AdminCustomerSectionsController');

  constructor(
    private readonly signIns: AdminCustomerSignIns,
    private readonly signInsExport: AdminCustomerSignInsExport,
    private readonly signInReveal: AdminCustomerSignInReveal,
    private readonly sessions: AdminCustomerSessions,
    private readonly signOut: AdminCustomerSignOut,
    private readonly passwordReset: AdminCustomerPasswordReset,
  ) {}

  // ---- security (identity) -------------------------------------------------------------------

  @Post(':accountId/sign-ins')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A customer’s sign-ins of the last 90 days (super list, admin)',
    description:
      'Needs customers.customers.view and identity.customer-sign-in.view. Body: `filters` ' +
      `(\`result\`: an array of success, failure, credential-change; ${INSTANTS}), \`sort\` ` +
      `(occurred), ${PAGING}. Each row: the sign-in id, when, the result, identity’s outcome code ` +
      'and the coarse device (`<browser>.<system>`, null when unknown). No address and no city ' +
      '(`city` is always null until the owner decides on a geo lookup). `since` is the oldest ' +
      'instant shown.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  listSignIns(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    return this.#list(context, request, response, accountId, body, (input) =>
      this.signIns.execute(context, input),
    );
  }

  @Post(':accountId/sign-ins/export')
  @HttpCode(200)
  @RequiresStepUp(CUSTOMERS_EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export a customer’s sign-ins as a CSV or XLSX file (admin)',
    description: `${EXPORT} Needs identity.customer-sign-in.view. No address in the file.`,
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
  async exportSignIns(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.#export(context, request, response, accountId, body, 'sign-ins', (input) =>
      this.signInsExport.execute(context, input),
    );
  }

  @Post(':accountId/sign-ins/:signInId/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reveal the full client address of one of a customer’s sign-ins (admin)',
    description:
      'Needs customers.customers.view, identity.customer-sign-in.view and the protected ' +
      'identity.customer-sign-in.reveal. No body (or `{}`). identity audits every reveal ' +
      '(identity.account.sign-in-address-revealed: the record id, never the address) in the unit ' +
      'that reads it, and the address is answered only after the timeline entry ' +
      '`sign-in-address-revealed` is written. Only the last 90 days. Personal data: not cached. ' +
      '404 customers.customer-not-found or customers.sign-in-not-found.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: `${NOT_FOUND} or customers.sign-in-not-found` })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async revealSignIn(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Param('signInId') signInId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = emptyBody(body);
    if (checked !== null) throw checked;
    return this.#settle(context, await this.signInReveal.execute(context, { accountId, signInId }));
  }

  @Get(':accountId/sessions')
  @ApiOperation({
    summary: 'A customer’s live sessions (admin)',
    description:
      'Needs customers.customers.view and identity.customer-sign-in.view. At most 50, most ' +
      'recently used first; `more` says there are others. Each: the coarse device, signed in, ' +
      'last active. No session id, token or address.',
  })
  @ApiOkResponse({ type: Object })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    return this.#settle(context, await this.sessions.execute(context, { accountId }));
  }

  @Post(':accountId/sessions/end')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign a customer out of every device (admin)',
    description:
      'Needs customers.customers.view and identity.customer-session.end. No body (or `{}`). ' +
      'Every session of the account ends; identity audits it with the count ' +
      '(identity.account.sessions-ended-by-admin) and the timeline gets `signed-out-by-admin`. ' +
      'No step-up, as for disabling the account. Answers `revokedSessions`.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async endSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = emptyBody(body);
    if (checked !== null) throw checked;
    return this.#settle(context, await this.signOut.execute(context, { accountId }));
  }

  @Post(':accountId/password-reset')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a customer the password reset mail (admin)',
    description:
      'Needs customers.customers.view and identity.customer-password-reset.send. No body (or ' +
      '`{}`). The reset link of “Forgot password?” goes to the customer’s own verified address; ' +
      'the admin sees no link or token. Audited by identity ' +
      '(identity.account.password-reset-sent-by-admin) and on the timeline ' +
      '(`password-reset-sent`). 409 customers.customer-not-eligible for a disabled or unverified ' +
      'account; 429 customers.password-reset-recently-requested within five minutes of the last ' +
      'request.',
  })
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: NOT_FOUND })
  @ApiConflictResponse({ ...ERROR, description: 'customers.customer-not-eligible' })
  @ApiTooManyRequestsResponse({
    ...ERROR,
    description: 'customers.password-reset-recently-requested',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async sendPasswordReset(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = emptyBody(body);
    if (checked !== null) throw checked;
    return this.#settle(context, await this.passwordReset.execute(context, { accountId }));
  }

  // ---- shared ----------------------------------------------------------------------------------

  #settle<T>(context: CallContext, result: Outcome<T>): T {
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }

  async #list(
    context: CallContext,
    request: Request,
    response: Response,
    accountId: string,
    body: unknown,
    run: (input: object) => Promise<Outcome<unknown>>,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, LIST_KEYS);
    if (checked !== null) throw checked;
    return this.#settle(context, await run({ ...(body as object), accountId }));
  }

  async #export(
    context: CallContext,
    request: Request,
    response: Response,
    accountId: string,
    body: unknown,
    section: string,
    run: (input: object) => Promise<Outcome<SectionExportFile>>,
  ): Promise<void> {
    const checked = closedBody(request, body, EXPORT_KEYS);
    const result = checked !== null ? null : await run({ ...(body as object), accountId });
    if (checked !== null || result === null || !result.ok) {
      const error =
        checked ??
        refusal(
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
        msg: 'customers.admin-customer-section-export',
        section,
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
