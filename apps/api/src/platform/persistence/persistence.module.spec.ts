import { MODULE_METADATA } from '@nestjs/common/constants';
import { testAppConfig } from '../../../test/support/test-config';
import { EVENT_BUS, OUTBOX_RELAY } from '../events/event-bus';
import { JOB_LOCK } from '../scheduler/job-lock';
import { InvalidUnitOfWorkOptionsError } from '../unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWorkOptions } from '../unit-of-work/unit-of-work';
import { DatabaseProbe } from './database-probe';
import { GUARDED_CLIENT } from './guarded-client';
import { PersistenceModule } from './persistence.module';
import { poolConfigOf, PrismaRoot } from './prisma-root';
import { PrismaService } from './prisma.service';
import { checkUnitOfWorkOptions } from './prisma-unit-of-work';

describe('PersistenceModule (platform persistence design 3.3)', () => {
  const providerTokens = (
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PersistenceModule) as (
      { provide: unknown } | (new (...args: never[]) => unknown)
    )[]
  ).map((provider) => ('provide' in provider ? provider.provide : provider));

  it('exports the door for modules, the UnitOfWork port, the probe and the event and scheduler port implementations, and nothing else (no outbox writer factory)', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, PersistenceModule)).toEqual([
      PrismaService,
      UNIT_OF_WORK,
      DatabaseProbe,
      EVENT_BUS,
      OUTBOX_RELAY,
      JOB_LOCK,
    ]);
  });

  it('provides the base client and the guarded client without exporting them', () => {
    expect(providerTokens).toEqual(
      expect.arrayContaining([PrismaRoot, GUARDED_CLIENT, PrismaService, UNIT_OF_WORK]),
    );
  });
});

describe('poolConfigOf (3.1 row 8; data platform.md 10.9)', () => {
  it('bounds the wait for a connection at 2 s and sets an explicit maximum', () => {
    const config = testAppConfig({ DATABASE_POOL_MAX: '7' });

    expect(poolConfigOf(config)).toEqual({
      connectionString: config.databaseUrl,
      max: 7,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
    });
  });

  it('defaults the maximum to 10 and never names prepared statements', () => {
    const pool = poolConfigOf(testAppConfig());

    expect(pool.max).toBe(10);
    expect(pool).not.toHaveProperty('statementNameGenerator');
  });
});

describe('checkUnitOfWorkOptions (3.1 rows 8 and 9; ADR-0025 condition (c))', () => {
  it.each<UnitOfWorkOptions>([
    {},
    { readOnly: true },
    { readOnly: false, isolation: 'serializable', timeoutMs: 30_000 },
    { timeoutMs: 1 },
  ])('accepts %j', (options) => {
    expect(() => checkUnitOfWorkOptions(options)).not.toThrow();
  });

  it.each<[UnitOfWorkOptions, string]>([
    [{ readOnly: true, isolation: 'serializable' }, 'read-only-with-isolation'],
    [{ readOnly: true, timeoutMs: 100 }, 'read-only-with-timeout'],
    [{ isolation: 'read-committed' as never }, 'unknown-isolation'],
    [{ timeoutMs: 0 }, 'timeout-out-of-range'],
    [{ timeoutMs: 30_001 }, 'timeout-out-of-range'],
    [{ timeoutMs: 1.5 }, 'timeout-out-of-range'],
  ])('refuses %j', (options, reason) => {
    expect(() => checkUnitOfWorkOptions(options)).toThrow(
      new InvalidUnitOfWorkOptionsError(reason as never),
    );
  });
});
