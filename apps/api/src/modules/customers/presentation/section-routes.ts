import type { HttpException, Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import type { SectionExportFile } from '../application/use-cases/admin-customer-sign-ins-export.use-case';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { closedBody, fail, refusal } from './http-answers';
import { writeChunks } from './write-chunks';

// What the customer page's section routes (customers management phase 2b) share: the OpenAPI
// wording, the closed bodies, and how a list, a read and an export are answered.

export const ERROR = { type: Object };
export const CSRF = {
  name: CSRF_HEADER,
  required: true,
  description: 'The CSRF token of the session',
};
export const UNAUTHORIZED = 'access.unauthenticated or session.invalid';
export const NOT_FOUND = 'customers.customer-not-found';
export const PAGING =
  '`direction` (desc, the default, or asc), `page`, `pageSize` (at most 100) and `paging` (pages, ' +
  'with the total, or prev-next: the Market’s List paging setting)';
export const INSTANTS =
  '`from`, `to`: ISO 8601 instants (the panel turns the admin’s local days into instants)';
export const EXPORT =
  'Needs customers.customers.view, the section’s own key and the protected ' +
  `customers.customers.export, and a fresh two-step proof for \`${CUSTOMERS_EXPORT_STEP_UP}\` ` +
  '(spent by the export). Body: `format` (csv, the default, or xlsx), `filters`, `sort` and ' +
  '`direction` as for the list. At most 10,000 rows. Audited ' +
  '(customers.customer-section.exported: the section, format and count).';

const LIST_KEYS = ['filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];
const EXPORT_KEYS = ['format', 'filters', 'sort', 'direction'];

export type Outcome<T> = Result<T, { readonly code: string } & Record<string, unknown>>;

/** A body that must be absent or `{}` (an action or a reveal takes nothing). */
export function emptyBody(body: unknown): HttpException | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0) {
    return null;
  }
  return fail(400, 'validation.failed', { fields: [{ path: '', code: 'unknown-field' }] });
}

/** The value of a success; a refusal becomes its HTTP answer (logged by `refusal`). */
export function settle<T>(logger: Logger, context: CallContext, result: Outcome<T>): T {
  if (!result.ok) throw refusal(result.error, context, logger);
  return result.value;
}

/** One page of a section's super list; the account comes from the path. */
export async function listRoute(
  logger: Logger,
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
  return settle(logger, context, await run({ ...(body as object), accountId }));
}

/** A read of a section that is not a list (no body); the account comes from the path. */
export async function readRoute(
  logger: Logger,
  context: CallContext,
  response: Response,
  accountId: string,
  run: (input: object) => Promise<Outcome<unknown>>,
): Promise<unknown> {
  response.setHeader('Cache-Control', 'no-store');
  return settle(logger, context, await run({ accountId }));
}

/** A section's export, streamed as an attachment; a refusal is answered as JSON. */
export async function exportRoute(
  logger: Logger,
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
        logger,
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
    logger.warn({
      msg: 'customers.admin-customer-section-export',
      section,
      code: 'stream-failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    response.destroy();
  }
}
