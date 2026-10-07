import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseRoleAccepted } from './check-database-role';
import { APP_OPTIONS, configureApp } from './configure-app';
import { loadEnvFile } from './load-env-file';
import type { AppConfig } from './platform/config/app-config';
import { APP_CONFIG } from './platform/config/config.module';
import { DatabaseProbe } from './platform/persistence/database-probe';

async function bootstrap(): Promise<void> {
  loadEnvFile();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(), APP_OPTIONS);
  const logger = app.get(Logger);
  app.useLogger(logger);
  configureApp(app);

  // Before listening, so a mis-wired database secret never serves a request (10.8).
  if (!(await databaseRoleAccepted(app.get(DatabaseProbe), logger))) {
    await app.close();
    process.exit(1);
  }

  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}

bootstrap().catch((error: unknown) => {
  // Startup failures (for example invalid configuration) happen before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
