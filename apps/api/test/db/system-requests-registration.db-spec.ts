import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import {
  SYSTEM_ACTION_PROPOSER,
  SYSTEM_REQUEST_RECORDER,
  type AppliedChange,
  type ProposedChange,
  type SystemActionProposer,
  type SystemRequestRecorder,
} from '../../src/modules/system-requests';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// The kinds the real modules registered at boot, end to end (Hassan's review of PR #904): a
// change or a proposal filed under an area other than the one its module registered the kind
// in is refused by the recorder, inside a real unit, before anything is written; the same kind
// in its own area opens a request. Every case runs for both Market fixtures.

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
/** A parsed (version 7) id, as a minted actor needs; random in its last part. */
const parsedId = <T extends string>(): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${randomUUID().slice(-12)}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe('system requests: real module registrations (database integration)', () => {
  let app: INestApplicationContext;
  let unitOfWork: UnitOfWork;
  let recorder: SystemRequestRecorder;
  let proposer: SystemActionProposer;
  let sql: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    app = await moduleRef.init();
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    recorder = app.get<SystemRequestRecorder>(SYSTEM_REQUEST_RECORDER);
    proposer = app.get<SystemActionProposer>(SYSTEM_ACTION_PROPOSER);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  describe.each(TEST_MARKETS.map((code) => [code]))('in market %s', (code) => {
    const market = marketOf(code);
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: parsedId<'Account'>(),
          sessionId: parsedId<'Session'>(),
          sellerId: null,
        }),
      );
    const rowsOf = async (subjectRef: string): Promise<number> => {
      const result = await sql.query<{ n: string }>(
        'SELECT count(*) AS n FROM system_requests.requests WHERE market_id = $1 AND subject_ref = $2',
        [market.marketId, subjectRef],
      );
      return Number(result.rows[0]!.n);
    };
    const openReview = (change: AppliedChange) =>
      unitOfWork.run(market, async () => ok(await recorder.openReview(admin(), change)));
    const proposeChange = (change: ProposedChange) =>
      unitOfWork.run(market, async () => ok(await proposer.proposeChange(admin(), change)));
    const change = (fields: Pick<AppliedChange, 'area' | 'subjectKind'>): AppliedChange => ({
      subjectRef: `ref-${randomUUID()}`,
      before: { name: 'Before' },
      after: { name: 'After' },
      note: 'Checking the registered area',
      ...fields,
    });

    it("refuses openReview of a real module's kind filed under another area, writing nothing", async () => {
      // settings registered `settings.market-setting` in marketplace; identity owns people.
      const settings = change({ area: 'people', subjectKind: 'settings.market-setting' });
      await expect(openReview(settings)).rejects.toThrow(
        'settings.market-setting is reviewed in marketplace, not people',
      );
      // catalog registered `catalog.category-details` in catalogue (reviewed by default).
      const catalog = change({ area: 'money', subjectKind: 'catalog.category-details' });
      await expect(openReview(catalog)).rejects.toThrow(
        'catalog.category-details is reviewed in catalogue, not money',
      );
      // identity's people kind filed under certification.
      const identity = change({ area: 'certification', subjectKind: 'identity.platform-role' });
      await expect(openReview(identity)).rejects.toThrow(
        'identity.platform-role is reviewed in people, not certification',
      );
      for (const refused of [settings, catalog, identity]) {
        expect(await rowsOf(refused.subjectRef)).toBe(0);
      }
      // The same kind in the area its module registered opens the request.
      const own = change({ area: 'catalogue', subjectKind: 'catalog.category-details' });
      const opened = await openReview(own);
      expect(opened).toMatchObject({ ok: true, value: { ok: true, value: { risk: 'medium' } } });
      expect(await rowsOf(own.subjectRef)).toBe(1);
    });

    it("refuses proposeChange of a real module's applier kind under another area, writing nothing", async () => {
      // catalog registered the applier `catalog.category-discard` in catalogue.
      const catalog = change({ area: 'delivery', subjectKind: 'catalog.category-discard' });
      await expect(proposeChange(catalog)).rejects.toThrow(
        'catalog.category-discard is reviewed in catalogue, not delivery',
      );
      // shipping registered the applier `shipping.fleet-selection-model-create` in delivery.
      const shipping = change({
        area: 'catalogue',
        subjectKind: 'shipping.fleet-selection-model-create',
      });
      await expect(proposeChange(shipping)).rejects.toThrow(
        'shipping.fleet-selection-model-create is reviewed in delivery, not catalogue',
      );
      // A reverter kind is no applier, in any area; an applier kind is not reviewed after.
      const reverterKind = change({ area: 'delivery', subjectKind: 'shipping.delivery-settings' });
      await expect(proposeChange(reverterKind)).rejects.toThrow(
        'no applier registered for shipping.delivery-settings',
      );
      const applierKind = change({ area: 'catalogue', subjectKind: 'catalog.category-discard' });
      await expect(openReview(applierKind)).rejects.toThrow(TypeError);
      for (const refused of [catalog, shipping, reverterKind, applierKind]) {
        expect(await rowsOf(refused.subjectRef)).toBe(0);
      }
    });
  });
});
