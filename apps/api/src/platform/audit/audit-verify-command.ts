import type { INestApplicationContext } from '@nestjs/common';
import { err, ok, parseCorrelationId } from '@mondapac/shared-kernel';
import type { IdGenerator, Result } from '@mondapac/shared-kernel';
import { createCallContext, systemActor } from '@mondapac/shared-kernel/contexts';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { AuditVerifier, type VerifyReport } from './audit-verifier';

/** The arguments of `audit-verify --market <id> [--full]` (docs/design/domain/platform-audit.md 8). */
export interface AuditVerifyArguments {
  readonly marketId: string;
  readonly full: boolean;
}

/** The exit codes of the command. */
export const AUDIT_VERIFY_EXIT = Object.freeze({
  /** Verified, no finding. */
  clean: 0,
  /** A usage error, a Market this stack does not host, or a failed start. */
  refused: 1,
  /** Verified, with at least one finding (each is also an alert line in the log). */
  findings: 2,
});

export const AUDIT_VERIFY_USAGE = 'usage: audit-verify --market <id> [--full]';

/** Reads the command line; anything but exactly one `--market <id>` and an optional `--full` is refused. */
export function parseAuditVerifyArguments(
  argv: readonly string[],
): Result<AuditVerifyArguments, 'usage'> {
  let marketId: string | undefined;
  let full = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--full' && !full) {
      full = true;
    } else if (argument === '--market' && marketId === undefined && index + 1 < argv.length) {
      marketId = argv[index + 1];
      index += 1;
    } else {
      return err('usage');
    }
  }
  return marketId === undefined || marketId.length === 0 ? err('usage') : ok({ marketId, full });
}

/** The command's output: positions and codes, never row content (PA 8). */
export function describeReport(report: VerifyReport): string {
  return JSON.stringify({
    marketId: report.marketId,
    mode: report.mode,
    pinnedHead: report.pinnedHead === null ? null : String(report.pinnedHead),
    fromSeq: report.fromSeq === null ? null : String(report.fromSeq),
    sealsChecked: report.sealsChecked,
    findings: report.findings.map((finding) => ({
      code: finding.code,
      epoch: finding.epoch,
      chainSeq: finding.chainSeq === null ? null : String(finding.chainSeq),
      auditLogId: finding.auditLogId,
    })),
  });
}

/**
 * The operator command `audit-verify --market <id> [--full]` of the api image (PA 8; the
 * pattern of identity design 7.4): the named Market's context from the factory (a Market this
 * stack does not host is refused), the system actor and a new correlation id, then one
 * verification, incremental unless `--full`. It reads only and writes nothing, so it needs no
 * operator log (PA 9.2 covers the commands that act as `SYSTEM`). Answers the exit code and
 * writes one JSON line through `write`.
 */
export async function runAuditVerifyCommand(
  app: INestApplicationContext,
  argv: readonly string[],
  write: (line: string) => void,
): Promise<number> {
  const parsed = parseAuditVerifyArguments(argv);
  if (!parsed.ok) {
    write(AUDIT_VERIFY_USAGE);
    return AUDIT_VERIFY_EXIT.refused;
  }
  const market = app.get(MarketContextFactory).forMarket(parsed.value.marketId);
  const correlationId = parseCorrelationId(
    app.get<IdGenerator>(ID_GENERATOR).next<'audit-verify'>(),
  );
  if (!market.ok || !correlationId.ok) {
    // The operator's input is not echoed.
    write('audit-verify: that Market is not hosted by this stack');
    return AUDIT_VERIFY_EXIT.refused;
  }
  const context = createCallContext(market.value, systemActor(market.value), correlationId.value);
  const report = await app
    .get(AuditVerifier)
    .verify(context, parsed.value.full ? 'full' : 'incremental');
  write(describeReport(report));
  return report.findings.length === 0 ? AUDIT_VERIFY_EXIT.clean : AUDIT_VERIFY_EXIT.findings;
}
