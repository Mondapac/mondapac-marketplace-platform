import type { LoggerService } from '@nestjs/common';
import type { DatabaseProbe } from './platform/persistence/database-probe';

type RoleProblem = Awaited<ReturnType<DatabaseProbe['roleProblems']>>[number];

/**
 * The start-up self-check (docs/design/data/platform.md 10.8): `main.ts` runs it once,
 * before the server listens. It logs each reason code with its role or schema name, never
 * the URL, and answers whether the process may go on.
 */
export async function databaseRoleAccepted(
  probe: { roleProblems(): Promise<readonly RoleProblem[]> },
  logger: LoggerService,
): Promise<boolean> {
  const problems = await probe.roleProblems();
  if (problems.length === 0) return true;
  const reasons = problems.map(({ code, subject }) =>
    subject === null ? code : `${code}(${subject})`,
  );
  logger.error(
    `The database role was refused by the start-up self-check: ${reasons.join(', ')}`,
    'DatabaseRoleCheck',
  );
  return false;
}
