import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import {
  AUDIT_VERIFY_EXIT,
  AUDIT_VERIFY_USAGE,
  parseAuditVerifyArguments,
  runAuditVerifyCommand,
} from './audit-verify-command';
import { AuditVerifier, type VerifyReport } from './audit-verifier';

// The operator command `audit-verify --market <id> [--full]` (docs/design/domain/platform-audit.md
// 8): its arguments, its exit codes, and an output with positions and codes only.

describe('parseAuditVerifyArguments', () => {
  it.each([
    [['--market', 'AU'], { marketId: 'AU', full: false }],
    [['--full', '--market', 'ZZ'], { marketId: 'ZZ', full: true }],
    [['--market', 'AU', '--full'], { marketId: 'AU', full: true }],
  ])('reads %j', (argv, expected) => {
    expect(parseAuditVerifyArguments(argv)).toEqual(ok(expected));
  });

  it.each([
    [[]],
    [['--full']],
    [['--market']],
    [['--market', '']],
    [['--market', 'AU', '--market', 'ZZ']],
    [['--market', 'AU', '--full', '--full']],
    [['--market', 'AU', 'extra']],
    [['--market=AU']],
  ])('refuses %j', (argv) => {
    expect(parseAuditVerifyArguments(argv)).toEqual(err('usage'));
  });
});

describe.each(TEST_MARKETS)('runAuditVerifyCommand for market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  function appWith(report: Partial<VerifyReport>) {
    const calls: [MarketContext, string, string][] = [];
    const verifier = {
      verify: (
        context: { market: MarketContext; actor: { kind: string }; correlationId: string },
        mode: string,
      ) => {
        calls.push([context.market, mode, context.actor.kind]);
        return Promise.resolve({
          marketId: context.market.marketId,
          mode,
          pinnedHead: 4n,
          fromSeq: 1n,
          sealsChecked: 4,
          findings: [],
          ...report,
        });
      },
    };
    const factory = {
      forMarket: (requested: string) =>
        requested === code ? ok(market) : err({ code: 'market.not-hosted' }),
    };
    const ids = new SequenceIdGenerator(
      new FixedClock(Temporal.Instant.from('2026-10-08T06:00:00Z')),
    );
    const app = {
      get: (token: unknown) =>
        token === AuditVerifier
          ? verifier
          : token === MarketContextFactory
            ? factory
            : token === ID_GENERATOR
              ? ids
              : undefined,
    } as unknown as INestApplicationContext;
    return { app, calls };
  }

  it('runs an incremental verification as the system actor and exits 0 with no finding', async () => {
    const { app, calls } = appWith({});
    const lines: string[] = [];

    await expect(
      runAuditVerifyCommand(app, ['--market', code], (l) => lines.push(l)),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.clean);
    expect(calls).toEqual([[market, 'incremental', 'system']]);
    expect(JSON.parse(lines[0]!)).toEqual({
      marketId: code,
      mode: 'incremental',
      pinnedHead: '4',
      fromSeq: '1',
      sealsChecked: 4,
      findings: [],
    });
  });

  it('runs a full verification with --full and exits 2 with findings, positions only', async () => {
    const { app, calls } = appWith({
      findings: [
        {
          code: 'audit.row.mismatch',
          marketId: code,
          epoch: 1,
          chainSeq: 2n,
          auditLogId: '01990000-0000-7000-8000-000000000002',
        },
      ],
    });
    const lines: string[] = [];

    await expect(
      runAuditVerifyCommand(app, ['--market', code, '--full'], (l) => lines.push(l)),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.findings);
    expect(calls[0]![1]).toBe('full');
    expect((JSON.parse(lines[0]!) as { findings: unknown }).findings).toEqual([
      {
        code: 'audit.row.mismatch',
        epoch: 1,
        chainSeq: '2',
        auditLogId: '01990000-0000-7000-8000-000000000002',
      },
    ]);
  });

  it('refuses a usage error and a Market this stack does not host, without echoing it', async () => {
    const { app, calls } = appWith({});
    const lines: string[] = [];

    await expect(runAuditVerifyCommand(app, ['--market'], (l) => lines.push(l))).resolves.toBe(
      AUDIT_VERIFY_EXIT.refused,
    );
    await expect(
      runAuditVerifyCommand(app, ['--market', 'XX<script>'], (l) => lines.push(l)),
    ).resolves.toBe(AUDIT_VERIFY_EXIT.refused);
    expect(lines[0]).toBe(AUDIT_VERIFY_USAGE);
    expect(lines[1]).not.toContain('XX');
    expect(calls).toEqual([]);
  });
});
