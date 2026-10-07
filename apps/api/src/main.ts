import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp } from './configure-app';
import { loadEnvFile } from './load-env-file';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';

async function bootstrap(): Promise<void> {
  loadEnvFile();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(), APP_OPTIONS);
  app.useLogger(app.get(Logger));
  configureApp(app);

  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (for example invalid configuration) happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
