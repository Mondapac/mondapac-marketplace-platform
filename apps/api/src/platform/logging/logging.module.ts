import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { CORRELATION_ID_HEADER, resolveCorrelationId } from './correlation-id';

@Module({})
export class LoggingModule {
  /**
   * Structured JSON logging. Every request gets a correlation id (taken from the
   * `x-correlation-id` header or generated), echoed on the response and attached to
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
              genReqId: (req: IncomingMessage, res: ServerResponse) => {
                const id = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
                res.setHeader(CORRELATION_ID_HEADER, id);
                return id;
              },
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
