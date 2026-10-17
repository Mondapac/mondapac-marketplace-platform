import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import type { Clock } from '@mondapac/shared-kernel';
import type { HttpLogger } from 'pino-http';
import { buildOpenApiDocument } from './openapi';
import { CLOCK } from './platform/clock/clock.module';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';
import { answerBodyError } from './platform/http/body-errors';
import { clientAddressResolver } from './platform/http/client-address';
import { securityHeaders } from './platform/http/security-headers';
import { HTTP_LOGGER } from './platform/logging/logging.module';

/**
 * Options for creating the application, shared by the real server (main.ts) and the HTTP
 * tests. Nest's own body parser is off: `configureApp` mounts the parser after the request
 * logger (slice 0 item 5).
 */
export const APP_OPTIONS = {
  bufferLogs: true,
  bodyParser: false,
} as const satisfies NestApplicationOptions;

/** The path prefix of the Stripe webhook routes (`payments`), the only raw-body routes. */
export const STRIPE_WEBHOOK_PATH = '/payments/stripe/webhook/';

/** True for a request to the Stripe webhook, query string ignored. */
export function isStripeWebhookPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?', 1)[0] ?? '';
  return path.startsWith(STRIPE_WEBHOOK_PATH);
}

/** A base64 photo of 4 MiB is 5.6 million characters; the rest is the JSON around it. */
const PRODUCT_IMAGE_BODY_LIMIT = '5800kb';
const PRODUCT_IMAGE_PATH = /^\/catalog\/seller\/products\/[0-9a-fA-F-]{36}\/images\/?(?:\?.*)?$/;

export function isProductImageUploadRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === 'POST' && url !== undefined && PRODUCT_IMAGE_PATH.test(url);
}

/** A base64 certificate file of 10 MiB is 14 million characters; the rest is the JSON around it. */
const CERTIFICATE_DOCUMENT_BODY_LIMIT = '14500kb';
const CERTIFICATE_DOCUMENT_PATH =
  /^\/certification\/seller\/certificates\/[0-9a-fA-F-]{36}\/documents\/?(?:\?.*)?$/;
/** "My issuer is not listed" carries one certificate file too (certification slice 6). */
const ISSUER_REQUEST_PATH = /^\/certification\/seller\/issuer-requests\/?(?:\?.*)?$/;

export function isCertificateDocumentUploadRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return (
    method === 'POST' &&
    url !== undefined &&
    (CERTIFICATE_DOCUMENT_PATH.test(url) || ISSUER_REQUEST_PATH.test(url))
  );
}

/**
 * HTTP-level setup shared by the real server (main.ts) and the HTTP tests, so what is
 * tested is what runs. The application must be created with {@link APP_OPTIONS}.
 *
 * Order: the request logger, the security headers, the client address (ADR-0037), the body
 * parser, then Nest's routes and guards. A request the parser rejects (malformed JSON, too
 * large) is therefore logged with its correlation id, and its answer carries the
 * `x-correlation-id` header (Security L4) and the security headers (item 6). A request whose
 * client address is refused is logged and carries the headers too, and its body is never parsed.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.disable('x-powered-by');
  // No proxy is trusted: `req.ip` is the socket's address, and nothing reads it. Behind a BFF the
  // client address is proven by the BFF instead (ADR-0037); never `true` (slice 0 item 6).
  app.set('trust proxy', false);
  app.enableShutdownHooks();

  app.use(app.get<HttpLogger>(HTTP_LOGGER));
  app.use(securityHeaders({ docsEnabled: config.apiDocsEnabled }));
  app.use(
    clientAddressResolver({ trust: config.clientAddressTrust, clock: app.get<Clock>(CLOCK) }),
  );
  // JSON only, at most 64 KiB, objects and arrays only. No CORS middleware until origins exist.
  // inflate: false - a compressed body is refused with 415, never decompressed (Hassan L1).
  // The Stripe webhook alone gets its body as raw bytes, because its signature is computed over
  // the exact bytes (Phase 5 package 2). Same limit and no decompression; the JSON parser then
  // skips that request, since this parser has already read it.
  app.useBodyParser('raw', {
    type: (request) => isStripeWebhookPath(request.url),
    limit: '64kb',
    inflate: false,
  });
  // The product photo route alone takes a larger body (a base64 photo of at most 4 MiB, catalog
  // slice 13), read as bytes; its controller parses the JSON itself. The JSON parser below then
  // skips that request, as it does for the webhook.
  app.useBodyParser('raw', {
    type: (request) => isProductImageUploadRequest(request.method, request.url),
    limit: PRODUCT_IMAGE_BODY_LIMIT,
    inflate: false,
  });
  // The certificate file route and the issuer request route alone take a still larger body (a
  // base64 file of at most 10 MiB, certification slices 4 and 6), read as bytes; their controllers
  // parse the JSON themselves.
  app.useBodyParser('raw', {
    type: (request) => isCertificateDocumentUploadRequest(request.method, request.url),
    limit: CERTIFICATE_DOCUMENT_BODY_LIMIT,
    inflate: false,
  });
  app.useBodyParser('json', { limit: '64kb', strict: true, inflate: false });
  app.use(answerBodyError);

  if (config.apiDocsEnabled) {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }
}
