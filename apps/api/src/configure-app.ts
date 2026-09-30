import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApiDocument } from './openapi';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';

/**
 * HTTP-level setup shared by the real server (main.ts) and the HTTP tests, so what is
 * tested is what runs.
 */
export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  if (app.get<AppConfig>(APP_CONFIG).apiDocsEnabled) {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }
}
