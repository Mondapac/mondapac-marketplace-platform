import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import {
  AREA_NAME_SOURCE,
  SERVICE_AREA_NAMES_REPOSITORY,
  type AreaNameSource,
  type AreaNamesApplied,
  type EditedNamesByArea,
  type ServiceAreaNamesRepository,
} from '../src/modules/sellers/application/ports/service-area-names.repository';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin Service area names page over HTTP (ADR-0041; super list phase 4, row actions): the
// real guards, controllers, gate, probe and use cases, identity's ports and the edited names in
// memory. Each row names its Actions menu: edit-names for a holder of sellers.service-area.edit.

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const EDITOR_ROLE = id<'Role'>(0xc001);
const VIEWER_ROLE = id<'Role'>(0xc002);

/** The edited names in memory: the store and the source the page reads them through. */
class EditedNames implements ServiceAreaNamesRepository, AreaNameSource {
  readonly rows = new Map<string, string>();
  all(market: MarketContext) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}|`))
        .map(([key, name]) => {
          const [, areaCode = '', locale = ''] = key.split('|');
          return { areaCode, locale, name };
        }),
    );
  }
  apply(
    market: MarketContext,
    areaCode: string,
    changes: ReadonlyMap<string, string | null>,
  ): Promise<AreaNamesApplied> {
    let set = 0;
    let restored = 0;
    for (const [locale, name] of changes) {
      const key = `${market.marketId}|${areaCode}|${locale}`;
      if (name === null) restored += Number(this.rows.delete(key));
      else if (this.rows.get(key) !== name) {
        this.rows.set(key, name);
        set += 1;
      }
    }
    return Promise.resolve({ set, restored });
  }
  async edited(market: MarketContext): Promise<EditedNamesByArea> {
    const out = new Map<string, Record<string, string>>();
    for (const row of await this.all(market)) {
      out.set(row.areaCode, { ...(out.get(row.areaCode) ?? {}), [row.locale]: row.name });
    }
    return out;
  }
  forget(): void {}
}

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let names: EditedNames;

describe('admin service area names over HTTP', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    fakes.reset();
    names = new EditedNames();
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(SERVICE_AREA_NAMES_REPOSITORY)
          .useValue(names)
          .overrideProvider(AREA_NAME_SOURCE)
          .useValue(names),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  function seed(code: string) {
    const marketId = code as AccountState['marketId'];
    let n = 0;
    for (const [accountId, roleId, keys] of [
      [EDITOR, EDITOR_ROLE, ['sellers.seller.view', 'sellers.service-area.edit']],
      [VIEWER, VIEWER_ROLE, ['sellers.seller.view']],
    ] as const) {
      n += 1;
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Role ${n}`,
        permissionKeys: [...keys],
        version: 1,
        createdAt: START,
      });
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `admin${n}@example.com`, normalized: `admin${n}@example.com` },
        displayName: `Admin ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe000 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
  }

  /** A session's cookie and its CSRF token, stored as a sign-in would. */
  function cookieOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      testMarketContext(code, PLATFORM_TENANT_ID),
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const headers = (code: string, session: ReturnType<typeof cookieOf>) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'admin'),
    ...session,
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('names Edit names on every row for an editor, and on none for a viewer', async () => {
      seed(code);
      const editor = await http()
        .get('/sellers/admin/service-areas')
        .set(headers(code, cookieOf(code, EDITOR, 1)));
      expect(editor.status).toBe(200);
      const editorAreas = (editor.body as { areas: { code: string; actions: string[] }[] }).areas;
      expect(editorAreas.length).toBeGreaterThan(0);
      expect(editorAreas.every((area) => area.actions.join() === 'edit-names')).toBe(true);

      const viewer = await http()
        .get('/sellers/admin/service-areas')
        .set(headers(code, cookieOf(code, VIEWER, 2)));
      expect(viewer.status).toBe(200);
      const viewerAreas = (viewer.body as { areas: { actions: string[] }[] }).areas;
      expect(viewerAreas.length).toBe(editorAreas.length);
      expect(viewerAreas.every((area) => area.actions.length === 0)).toBe(true);
    });

    it('answers the edited row with its Edit names action', async () => {
      seed(code);
      const cookie = cookieOf(code, EDITOR, 3);
      const listed = await http().get('/sellers/admin/service-areas').set(headers(code, cookie));
      const areaCode = (listed.body as { areas: { code: string }[] }).areas[0]!.code;
      const edited = await http()
        .post('/sellers/admin/service-areas/names')
        .set(headers(code, cookie))
        .send({ areaCode, names: { en: 'Renamed area' } });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({
        changed: 1,
        area: { code: areaCode, actions: ['edit-names'], names: { en: { edited: true } } },
      });
    });
  });
});
