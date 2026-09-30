import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.register(), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  if (config.nodeEnv !== 'production') {
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  }

  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (for example invalid configuration) happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
