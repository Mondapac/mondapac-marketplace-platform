import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type {
  PasswordHasher,
  PasswordHasherBusy,
  PasswordVerification,
} from '../../src/modules/identity/application/ports/password-hasher';
import type {
  ProviderIdentity,
  SignInProviders,
} from '../../src/modules/identity/application/ports/sign-in-providers';
import { SignInWithProvider } from '../../src/modules/identity/application/use-cases/sign-in-with-provider.use-case';
import { IDENTITY_EVENTS } from '../../src/modules/identity/domain/events';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import { PrismaSessionRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-session.repository';
import { PrismaSignInRecordRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-sign-in-record.repository';
import { RandomSessionTokens } from '../../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { HmacFlowSecrets } from '../../src/modules/identity/infrastructure/social/hmac-flow-secrets';
import { PrismaExternalIdentityRepository } from '../../src/modules/identity/infrastructure/social/prisma-external-identity.repository';
import type { AccessDecision, AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';
import { createSecurityEvents } from '../../src/platform/persistence/audit/prisma-security-events';

// Social sign-in on PostgreSQL, as the application role, for both Market fixtures: the real
// repositories, unit of work, tokens and flow secrets; the provider and the hasher are stand-ins
// (the provider adapter is tested on its own). Covers the new table's keys, checks and cascade.

class StubHasher implements PasswordHasher {
  hash(plain: string): Promise<Result<string, PasswordHasherBusy>> {
    return Promise.resolve(ok(`$argon2id$v=19$m=65536,t=3,p=1$fake$${plain}`));
  }
  verify(): Promise<Result<PasswordVerification, PasswordHasherBusy>> {
    return Promise.resolve(ok({ matches: false, needsRehash: false }));
  }
}

const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe('social sign-in (database integration)', () => {
  const clock = new FixedClock(Temporal.Instant.from('2026-10-19T00:00:00Z'));
  const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
  const flowSecrets = new HmacFlowSecrets();
  let person: ProviderIdentity;
  const providers: SignInProviders = {
    configured: () => ['google'],
    authorizationUrl: () => 'https://provider.test/auth',
    exchange: () => Promise.resolve(ok(person)),
  };
  let db: Persistence;
  let sql: Client;
  let accounts: PrismaAccountRepository;
  let identities: PrismaExternalIdentityRepository;
  let signIn: SignInWithProvider;
  let warnings: jest.SpyInstance;

  beforeAll(async () => {
    db = createPersistence();
    const catalogue = new EventCatalogue();
    catalogue.register('identity', IDENTITY_EVENTS);
    catalogue.seal();
    accounts = new PrismaAccountRepository(
      db.service,
      new NodeSubjectKeyService(
        new PrismaSubjectKeyStore(db.service, db.unitOfWork),
        new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
        clock,
      ),
    );
    identities = new PrismaExternalIdentityRepository(db.service);
    signIn = new SignInWithProvider(createUseCaseGate(markets, allow), {
      unitOfWork: db.unitOfWork,
      accounts,
      externalIdentities: identities,
      sessions: new PrismaSessionRepository(db.service),
      records: new PrismaSignInRecordRepository(db.service),
      securityEvents: createSecurityEvents('identity', { ids, clock }),
      hasher: new StubHasher(),
      tokens: new RandomSessionTokens(),
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('identity'),
      signInProviders: providers,
      flowSecrets,
      policy: new MarketConfigIdentityPolicy(markets),
      clock,
      ids,
    });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const context = () => testCallContext(market, 'anonymous', `db-social-${randomUUID()}`);
    /** One read in a read-only unit (the repositories run only inside a unit). */
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await db.unitOfWork.run(market, async () => ok(await work()), {
        readOnly: true,
      });
      if (!result.ok) throw new Error('read failed');
      return result.value;
    };
    const attempt = () => {
      const flowSecret = flowSecrets.issue();
      const { state } = flowSecrets.derive(flowSecret, market, 'google', 'sign-in')!;
      return signIn.execute(context(), {
        provider: 'google',
        code: 'code',
        state,
        flowSecret,
        client: { origin: '10.1.2.3', address: '10.1.2.3' },
      });
    };

    it('creates a verified account and its identity once, then signs the same person in', async () => {
      const subject = `sub-${randomUUID()}`;
      person = { subject, email: `${subject}@example.com`, emailVerified: true };

      const first = await attempt();
      const second = await attempt();

      expect(first).toMatchObject({ ok: true, value: { code: 'signed-in', created: true } });
      expect(second).toMatchObject({ ok: true, value: { code: 'signed-in', created: false } });
      const row = await read(() => identities.findBySubject(market, 'google', subject));
      expect(row).not.toBeNull();
      const account = await read(() => accounts.findById(market, row!.accountId));
      expect(account!.isEmailVerified).toBe(true);
      expect(account!.state.population).toBe('customer');
      expect(await read(() => identities.findForAccount(market, row!.accountId, 'google'))).toEqual(
        row,
      );
    });

    it('answers link-required for an email a password account holds, and writes nothing', async () => {
      const subject = `sub-${randomUUID()}`;
      person = { subject, email: `${subject}@example.com`, emailVerified: true };
      const first = await attempt();
      expect(first.ok).toBe(true);
      // Another provider subject with the same email: never connected automatically.
      person = { ...person, subject: `${subject}-other` };

      expect(await attempt()).toEqual({ ok: false, error: { code: 'link-required' } });
      expect(
        await read(() => identities.findBySubject(market, 'google', `${subject}-other`)),
      ).toBeNull();
    });

    it('refuses a second row for the subject or for the account and provider', async () => {
      const subject = `sub-${randomUUID()}`;
      person = { subject, email: `${subject}@example.com`, emailVerified: true };
      expect((await attempt()).ok).toBe(true);
      const row = (await read(() => identities.findBySubject(market, 'google', subject)))!;

      const again = await db.unitOfWork.run(market, () =>
        identities.add(market, { ...row, accountId: randomUUID() as Id<'Account'> }),
      );
      const second = await db.unitOfWork.run(market, () =>
        identities.add(market, { ...row, subject: `${subject}-2` }),
      );

      expect(again).toEqual({ ok: false, error: { code: 'identity.taken' } });
      expect(second).toEqual({ ok: false, error: { code: 'identity.taken' } });
    });

    it('removes the identity with its account', async () => {
      const subject = `sub-${randomUUID()}`;
      person = { subject, email: `${subject}@example.com`, emailVerified: true };
      expect((await attempt()).ok).toBe(true);
      const row = (await read(() => identities.findBySubject(market, 'google', subject)))!;

      await db.unitOfWork.run(market, async () => {
        const account = await accounts.findById(market, row.accountId);
        await accounts.remove(market, account!);
        return ok(undefined);
      });

      const left = await sql.query(
        'SELECT 1 FROM identity.external_identities WHERE market_id = $1 AND subject = $2',
        [market.marketId, subject],
      );
      expect(left.rowCount).toBe(0);
    });
  });
});
