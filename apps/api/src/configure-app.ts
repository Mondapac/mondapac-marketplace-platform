import type { NextFunction, Request, Response } from 'express';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import type { HttpLogger } from 'pino-http';
import { buildOpenApiDocument } from './openapi';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';
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

/**
 * Hands a parser error to the request logger, so the request's one completion line names
 * the error's type. Express calls it only for an error raised before it (the parser's).
 */
function tagParserError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof Error) res.err = error;
  next(error);
}

/**
 * HTTP-level setup shared by the real server (main.ts) and the HTTP tests, so what is
 * tested is what runs. The application must be created with {@link APP_OPTIONS}.
 *
 * Order: the request logger, then the body parser, then Nest's routes and guards. A request
 * the parser rejects (malformed JSON, too large) is therefore logged with its correlation
 * id, and the answer carries the `x-correlation-id` header (Security L4).
 */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  app.use(app.get<HttpLogger>(HTTP_LOGGER));
  // The parsers Nest mounts by default, unchanged; item 6 narrows them.
  app.useBodyParser('json');
  app.useBodyParser('urlencoded', { extended: true });
  app.use(tagParserError);

  if (app.get<AppConfig>(APP_CONFIG).apiDocsEnabled) {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }
}
