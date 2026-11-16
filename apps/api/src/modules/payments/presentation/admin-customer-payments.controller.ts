import {
  Body,
  Controller,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS, RequiresStepUp } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { writeChunks, type ExportFile } from '../../../platform/list-export';
import { AdminCustomerDisputesExport } from '../application/use-cases/admin-customer-disputes-export.use-case';
import { AdminCustomerDisputes } from '../application/use-cases/admin-customer-disputes.use-case';
import { AdminCustomerPaymentsExport } from '../application/use-cases/admin-customer-payments-export.use-case';
import { AdminCustomerPayments } from '../application/use-cases/admin-customer-payments.use-case';

const ERROR = { type: Object };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
const EXPORT_STEP_UP = 'customers.customers.export';
const PAGING =
  '`direction` (desc, the default, or asc), `page`, `pageSize` (at most 100) and `paging` (pages, ' +
  'with the total, or prev-next: the Market’s List paging setting)';
const INSTANTS =
  '`from`, `to`: ISO 8601 instants (the panel turns the admin’s local days into instants)';

/** The HTTP status of each refusal of the customer payment routes. */
export const PAYMENTS_CUSTOMER_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'batch.too-large': 413,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  ...ACCESS_DENIED_STATUS,
});

const DETAILS = ['fields', 'max', 'total', 'actionKey'] as const;

function refusal(
  error: { readonly code: string },
  context: CallContext,
  logger: Logger,
): HttpException {
  const status = PAYMENTS_CUSTOMER_STATUS[error.code];
  if (status === undefined) {
    logger.error({
      msg: 'payments.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return new HttpException({ statusCode: 500, code: 'internal' }, 500);
  }
  const record = error as Record<string, unknown>;
  const details = Object.fromEntries(
    DETAILS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]),
  );
  return new HttpException(
    {
      statusCode: status,
      code: error.code,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    },
    status,
  );
}

function closedBody(
  request: Request,
  body: unknown,
  allowed: readonly string[],
): HttpException | null {
  if (request.is('application/json') !== 'application/json') {
    return new HttpException({ statusCode: 415, code: 'request.body-unsupported' }, 415);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return new HttpException(
      {
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: '', code: 'type' }] },
      },
      400,
    );
  }
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  return unknown.length === 0
    ? null
    : new HttpException(
        {
          statusCode: 400,
          code: 'validation.failed',
          details: {
            fields: unknown
              .sort()
              .slice(0, 10)
              .map((key) => ({
                path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
                code: 'unknown-field',
              })),
          },
        },
        400,
      );
}

const bigints = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );

const LIST_KEYS = ['filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];
const EXPORT_KEYS = ['format', 'filters', 'sort', 'direction'];

/**
 * One customer's payments and disputes for the customer page (customers management phase 2b):
 * two super lists and their exports. A payments path: no card detail, no provider id but the
 * payment's own (pi_...); amounts are minor units as digits with the currency. `no-store`.
 */
@ApiTags('payments')
@RoutePopulation('admin')
@ReadsSession()
@Controller('payments/admin/customers')
export class AdminCustomerPaymentsController {
  readonly #logger = new Logger('AdminCustomerPaymentsController');

  constructor(
    private readonly payments: AdminCustomerPayments,
    private readonly paymentsExport: AdminCustomerPaymentsExport,
    private readonly disputes: AdminCustomerDisputes,
    private readonly disputesExport: AdminCustomerDisputesExport,
  ) {}

  @Post(':accountId/payments')
  @HttpCode(200)
  @ApiOperation({
    summary: 'One customer’s payments (super list, admin)',
    description:
      'Needs payments.customer-payment.view. Body: `filters` (`paymentState`: an array of none, ' +
      `authorised, captured, voided; \`status\`: an array of pending-payment, confirmed, cancelled; ${INSTANTS}, ` +
      `on the order’s creation), \`sort\` (created, the default, or amount), ${PAGING}. Each ` +
      'order’s payment: state, payment state, amount, Stripe’s payment id, created and confirmed. ' +
      '`paid` is what the customer paid (captured orders), one sum per currency.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listPayments(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, LIST_KEYS);
    if (checked !== null) throw checked;
    const result = await this.payments.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return bigints(result.value);
  }

  @Post(':accountId/payments/export')
  @HttpCode(200)
  @RequiresStepUp(EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export one customer’s payments as a CSV or XLSX file (admin)',
    description:
      'Needs payments.customer-payment.view and customers.customers.export (protected) and a ' +
      `fresh two-step proof for \`${EXPORT_STEP_UP}\` (spent by the export). Body: \`format\` ` +
      '(csv, the default, or xlsx), `filters`, `sort` and `direction` as for the list. At most ' +
      '10,000 rows. Audited (format and count).',
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
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportPayments(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.#stream(context, request, response, body, (input) =>
      this.paymentsExport.execute(context, { ...input, accountId }),
    );
  }

  @Post(':accountId/disputes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The disputes of one customer’s orders (super list, admin)',
    description:
      'Needs payments.customer-payment.view. Body: `filters` (`status`: an array of Stripe’s ' +
      `dispute states; ${INSTANTS}, on when it opened), \`sort\` (opened, the default, amount or ` +
      `due), ${PAGING}. Each dispute: state, reason code, amount, opened, evidence due by and ` +
      'outcome; no provider id, no evidence, no buyer text. 413 batch.too-large for a customer ' +
      'with more than 10,000 orders.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: Object })
  @ApiOkResponse({ type: Object })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async listDisputes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const checked = closedBody(request, body, LIST_KEYS);
    if (checked !== null) throw checked;
    const result = await this.disputes.execute(context, { ...(body as object), accountId });
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return bigints(result.value);
  }

  @Post(':accountId/disputes/export')
  @HttpCode(200)
  @RequiresStepUp(EXPORT_STEP_UP)
  @ApiOperation({
    summary: 'Export the disputes of one customer’s orders as a CSV or XLSX file (admin)',
    description:
      'Needs payments.customer-payment.view and customers.customers.export (protected) and a ' +
      `fresh two-step proof for \`${EXPORT_STEP_UP}\` (spent by the export). Body: \`format\`, ` +
      '`filters`, `sort` and `direction` as for the list. At most 10,000 rows. Audited.',
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
  @ApiPayloadTooLargeResponse({ ...ERROR, description: 'batch.too-large (details.max)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async exportDisputes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res() response: Response,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.#stream(context, request, response, body, (input) =>
      this.disputesExport.execute(context, { ...input, accountId }),
    );
  }

  async #stream(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
    run: (
      input: object,
    ) => Promise<
      | { readonly ok: true; readonly value: ExportFile }
      | { readonly ok: false; readonly error: { readonly code: string } }
    >,
  ): Promise<void> {
    const checked = closedBody(request, body, EXPORT_KEYS);
    const result = checked !== null ? null : await run(body as object);
    if (checked !== null || result === null || !result.ok) {
      const error: HttpException =
        checked ?? refusal((result as { error: { code: string } }).error, context, this.#logger);
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
        msg: 'payments.admin-customer-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }
}
