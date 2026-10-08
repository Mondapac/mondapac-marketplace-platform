import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import { loadEnvFile } from './load-env-file';
import { AUDIT_VERIFY_EXIT, runAuditVerifyCommand } from './platform/audit/audit-verify-command';
import { loadAppConfig } from './platform/config/app-config';
import { DatabaseProbe } from './platform/persistence/database-probe';

/**
 * The operator command `audit-verify --market <id> [--full]` of the api image
 * (docs/design/domain/platform-audit.md 8): `node dist/audit-verify.js --market AU --full`.
 * It builds the same module graph as the api, runs the start-up self-checks, verifies the
 * named Market's audit chain once (incremental unless `--full`) and exits 0 when clean, 2
 * with findings (each also an alert line in the log), 1 when refused. Nothing is written to
 * the database. No HTTP listener, no worker runtime.
 */
async function main(): Promise<number> {
  loadEnvFile();
  const config = loadAppConfig(process.env);
  const context = await NestFactory.createApplicationContext(AppModule.register({ config }), {
    bufferLogs: true,
  });
  try {
    const logger = context.get(Logger);
    context.useLogger(logger);
    if (!(await databaseAccepted(context.get(DatabaseProbe), logger))) {
      return AUDIT_VERIFY_EXIT.refused;
    }
    return await runAuditVerifyCommand(context, process.argv.slice(2), (line) => {
      process.stdout.write(`${line}\n`);
    });
  } finally {
    await context.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // A failure before the logger exists, or a database error during the verification.
    console.error(error instanceof Error ? error.message : error);
    process.exit(AUDIT_VERIFY_EXIT.refused);
  },
);
