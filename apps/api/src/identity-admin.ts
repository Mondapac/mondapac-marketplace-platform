import 'reflect-metadata';
import { hostname, userInfo } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { databaseAccepted } from './check-database-role';
import { loadEnvFile } from './load-env-file';
import { IDENTITY_OPERATOR_COMMANDS, IDENTITY_OPERATOR_USAGE } from './modules/identity';
import { InvalidConfigError, loadAppConfig } from './platform/config/app-config';
import { OPERATOR_COMMAND_EXIT, runOperatorCommand } from './platform/operator/operator-command';
import { DatabaseProbe } from './platform/persistence/database-probe';

/**
 * The operator commands of identity design 7.4 in the api image:
 * `APP_ROLE=api node dist/identity-admin.js first-admin --market AU --email <address>` and
 * `... reset-admin-second-factor --market AU --email <address>`. Same configuration, module graph
 * and start-up checks as the api; no HTTP listener, no worker runtime. Before acting, each writes
 * the operator line of `platform-audit.md` 9.2 (OS user, host, command, Market, correlation id)
 * to standard error, the stand-in of the external log until Kazem's sink exists; the result
 * goes to standard output as one JSON line of codes and ids. Exit 0 done, 2 declined by the use
 * case, 1 refused.
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
      return OPERATOR_COMMAND_EXIT.refused;
    }
    return await runOperatorCommand(
      context,
      IDENTITY_OPERATOR_COMMANDS,
      process.argv.slice(2),
      { osUser: userInfo().username, host: hostname() },
      (line) =>
        new Promise<void>((resolve, reject) =>
          process.stderr.write(`${line}\n`, (error) => (error ? reject(error) : resolve())),
        ),
      (line) => process.stdout.write(`${line}\n`),
      IDENTITY_OPERATOR_USAGE,
    );
  } finally {
    await context.close();
  }
}

/** An error's class name only: a driver message can quote values, so it is never printed. */
function classOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : 'Error';
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof InvalidConfigError ? error.message : `identity-admin: the command failed (${classOf(error)})`}\n`,
    );
    process.exit(OPERATOR_COMMAND_EXIT.refused);
  },
);
