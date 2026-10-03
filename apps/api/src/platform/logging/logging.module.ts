import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { parseCorrelationId } from '@mondapac/shared-kernel';
import type { CorrelationId } from '@mondapac/shared-kernel';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { CORRELATION_ID_HEADER } from './correlation-id';

/**
 * The caller's `x-correlation-id` when it fits the kernel's rule, as `clientRequestId`
 * (ADR-0020 decision 8). It is added to the one completion line of a request and goes
 * nowhere else; a malformed or repeated value is dropped.
 */
function clientRequestIdOf(req: IncomingMessage): { clientRequestId?: CorrelationId } {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  if (typeof incoming !== 'string') return {};
  const parsed = parseCorrelationId(incoming);
  return parsed.ok ? { clientRequestId: parsed.value } : {};
}

@Module({})
export class LoggingModule {
  /**
   * Structured JSON logging. Every request gets a generated correlation id (a random UUID;
   * never the caller's), returned in the `x-correlation-id` response header and attached to
   * every log line written while handling that request.
   *
   * @param destination where log lines go; defaults to stdout. Tests pass a stream.
   */
  static forRoot(destination?: DestinationStream): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => {
            const options: Options = {
              level: config.logLevel,
              genReqId: (_req: IncomingMessage, res: ServerResponse) => {
                const id = randomUUID();
                res.setHeader(CORRELATION_ID_HEADER, id);
                return id;
              },
              // A request ends with exactly one of these two lines.
              customSuccessObject: (req: IncomingMessage, _res: ServerResponse, value: object) => ({
                ...value,
                ...clientRequestIdOf(req),
              }),
              customErrorObject: (
                req: IncomingMessage,
                _res: ServerResponse,
                _error: Error,
                value: object,
              ) => ({ ...value, ...clientRequestIdOf(req) }),
              // Top-level field on every line logged while handling the request.
              customProps: (req: IncomingMessage) => ({ correlationId: req.id }),
              // Headers can carry credentials; log only what is needed to trace a request.
              serializers: {
                // Path only: query strings can carry tokens (password reset, verification).
                req: (req: { method: string; url: string }) => ({
                  method: req.method,
                  url: req.url.split('?', 1)[0],
                }),
                res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
              },
            };
            return {
              pinoHttp: destination ? ([options, destination] as const) : options,
            };
          },
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
