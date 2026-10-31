import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  changeTrailOf,
  FakeChangeActors,
  InMemoryAuditTrail,
} from '../../../../test/support/change-trail-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SupportContactChanged } from '../domain/audit';
import { parseSupportEmail } from '../domain/support-email';
import { ViewPublicSupportContact } from './use-cases/view-public-support-contact.use-case';
import { ConfigNotificationsPolicy } from '../infrastructure/config-notifications-policy';
import type { NotificationsDependencies } from './notifications-dependencies';
import type {
  SupportContactRecord,
  SupportContactRepository,
} from './ports/support-contact.repository';
import { SetSupportContact } from './use-cases/set-support-contact.use-case';
import { ViewSupportContact } from './use-cases/view-support-contact.use-case';
import { ViewSupportContactHistory } from './use-cases/view-support-contact-history.use-case';

// The support email in memory on both Market fixtures (AU has a configured default, ZZ has none):
// an admin reads it, changes it with a version and an audit row, and nobody else can.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);

class RecordingAudit extends InMemoryAuditTrail implements AuditWriter {
  override record(context: CallContext, entry: AuditEntry): Promise<void> {
    if (entry.action !== SupportContactChanged.action) throw new Error('audit: unknown action');
    return super.record(context, entry);
  }
}

class MemoryContacts implements SupportContactRepository {
  readonly rows: (SupportContactRecord & { previousEmail: string | null; changedBy: string })[] =
    [];
  taken = false;
  latest() {
    return Promise.resolve(this.rows.at(-1) ?? null);
  }
  append(
    _m: MarketContext,
    record: SupportContactRecord & { previousEmail: string | null; changedBy: Id<'Account'> },
  ) {
    if (this.taken) return Promise.resolve(false);
    this.rows.push(record);
    return Promise.resolve(true);
  }
}

describe('parseSupportEmail', () => {
  it('trims and lower-cases a plain address', () => {
    expect(parseSupportEmail('  Help@Example.COM ')).toEqual(ok('help@example.com'));
    expect(parseSupportEmail('a.b+c@mail.example.com.au')).toEqual(ok('a.b+c@mail.example.com.au'));
  });

  it.each([
    '',
    '   ',
    'plain',
    'a@b',
    'a@@b.com',
    'a b@c.com',
    'a@b.com, c@d.com',
    '<a@b.com>',
    'a@b.',
    `${'x'.repeat(250)}@b.com`,
    'a@b\u0000.com',
    'supp\u043ert@mondapac.com',
    'a?subject=x@b.com',
    'a%40b@c.com',
    'a#b@c.com',
    'a@b.c',
    'a@b_c.com',
    null,
    undefined,
    42,
    {},
  ])('refuses %p', (value) => {
    expect(parseSupportEmail(value)).toEqual(err({ code: 'validation.failed', path: 'email' }));
  });
});

describe.each([
  ['AU', 'jnamazi@gmail.com'],
  ['ZZ', null],
] as const)('support contact in market %s', (code, configured) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `notif-${population}-abcd`,
    );
  const admin = actor('admin');

  let contacts: MemoryContacts;
  let audit: RecordingAudit;
  let actors: FakeChangeActors;
  let unitOfWork: FakeUnitOfWork;
  let deps: NotificationsDependencies;

  beforeEach(() => {
    contacts = new MemoryContacts();
    audit = new RecordingAudit(clock);
    actors = new FakeChangeActors();
    unitOfWork = new FakeUnitOfWork();
    deps = {
      unitOfWork,
      contacts,
      policy: new ConfigNotificationsPolicy(markets),
      audit,
      clock,
      trail: changeTrailOf(unitOfWork, audit, actors),
    };
  });

  const view = (context: CallContext = admin) =>
    new ViewSupportContact(gate, deps).execute(context, {});
  // By default the caller saves from the version in force, as the screen does.
  const set = (
    email: unknown,
    context: CallContext = admin,
    expectedVersion: unknown = contacts.rows.at(-1)?.version ?? 0,
  ) => new SetSupportContact(gate, deps).execute(context, { email, expectedVersion });

  it('shows the Market default (version 0) until an admin changes it', async () => {
    expect(await view()).toEqual(ok({ email: configured, version: 0, lastChanged: null }));
  });

  it('stores each change as a new version with who, when and the old address, and audits it', async () => {
    expect(await set('Help@Example.com')).toMatchObject(
      ok({ email: 'help@example.com', version: 1 }),
    );
    expect(await set('care@example.com')).toMatchObject(
      ok({ email: 'care@example.com', version: 2 }),
    );
    expect(contacts.rows).toEqual([
      {
        version: 1,
        email: 'help@example.com',
        changedAt: T0,
        previousEmail: configured,
        changedBy: ADMIN,
      },
      {
        version: 2,
        email: 'care@example.com',
        changedAt: T0,
        previousEmail: 'help@example.com',
        changedBy: ADMIN,
      },
    ]);
    expect(await view()).toMatchObject(ok({ email: 'care@example.com', version: 2 }));
    expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      ['notifications.support-contact.changed', 'support-email', { version: 0 }, { version: 1 }],
      ['notifications.support-contact.changed', 'support-email', { version: 1 }, { version: 2 }],
    ]);
  });

  it('writes nothing when the same address is set again', async () => {
    await set('help@example.com');
    expect(await set(' HELP@example.com ')).toMatchObject(
      ok({ email: 'help@example.com', version: 1 }),
    );
    expect(contacts.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    if (configured !== null) {
      contacts.rows.length = 0;
      audit.rows.length = 0;
      audit.entries.length = 0;
      expect(await set(configured)).toMatchObject(ok({ email: configured, version: 0 }));
      expect(contacts.rows).toEqual([]);
    }
  });

  it('refuses a bad address with the field and writes nothing', async () => {
    expect(await set('not-an-email')).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] }),
    );
    expect(await set(undefined)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(contacts.rows).toEqual([]);
    expect(audit.entries).toEqual([]);
  });

  it('refuses a save from an older version, and a missing or bad expected version', async () => {
    await set('help@example.com');
    expect(await set('care@example.com', admin, 0)).toMatchObject(
      err({ code: 'notifications.conflict' }),
    );
    for (const bad of ['x', -1, 1.5, '1', null, NaN]) {
      expect(await set('care@example.com', admin, bad)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'expectedVersion', code: 'range' }] }),
      );
    }
    expect(contacts.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
  });

  it('answers a conflict when another admin saved the same version first', async () => {
    contacts.taken = true;
    expect(await set('help@example.com')).toMatchObject(err({ code: 'notifications.conflict' }));
    expect(audit.entries).toEqual([]);
  });

  it('says who changed the address last and when, on the read and on the save', async () => {
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    const saved = await set('help@example.com');
    expect(saved).toEqual(
      ok({
        email: 'help@example.com',
        version: 1,
        lastChanged: { at: T0, byDisplayName: 'Sara K.', byKind: 'member' },
      }),
    );
    expect(await view()).toEqual(saved);
  });

  it('keeps the change when its author cannot be named any more, and for a system change', async () => {
    await set('help@example.com');
    expect(await view()).toMatchObject({
      value: { lastChanged: { at: T0, byDisplayName: null, byKind: 'member' } },
    });
    audit.rows[0] = { ...audit.rows[0]!, actorType: 'SYSTEM', actorId: null };
    expect(await view()).toMatchObject({
      value: { lastChanged: { at: T0, byDisplayName: null, byKind: 'system' } },
    });
  });

  it('still shows the page when the names cannot be read', async () => {
    await set('help@example.com');
    actors.failure = new Error('identity is down');
    expect(await view()).toEqual(ok({ email: 'help@example.com', version: 1, lastChanged: null }));
  });

  it('names the winning save on a conflict', async () => {
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    await set('help@example.com');
    expect(await set('care@example.com', admin, 0)).toEqual(
      err({
        code: 'notifications.conflict',
        lastChanged: { at: T0, byDisplayName: 'Sara K.', byKind: 'member' },
      }),
    );
  });

  it('lists the changes newest first with the field name and the author, never an address', async () => {
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
    await set('help@example.com');
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    await set('care@example.com');
    const page = await new ViewSupportContactHistory(gate, deps).execute(admin, { limit: 1 });
    expect(page).toMatchObject(
      ok({
        items: [
          {
            at: T0.add({ minutes: 5 }),
            byDisplayName: 'Sara K.',
            byKind: 'member',
            fields: ['email'],
          },
        ],
      }),
    );
    const next = page.ok ? page.value.next : null;
    expect(next).not.toBeNull();
    const second = await new ViewSupportContactHistory(gate, deps).execute(admin, { after: next });
    expect(second.ok && second.value.items.map((i) => i.at)).toEqual([T0]);
    expect(second.ok && second.value.next).toBeNull();
    expect(JSON.stringify([page, second])).not.toContain('example.com');
  });

  it('refuses a bad page request, and a history to anyone but an admin', async () => {
    const history = (context: CallContext, input: object) =>
      new ViewSupportContactHistory(gate, deps).execute(context, input);
    expect(await history(admin, { limit: 0 })).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] }),
    );
    expect(await history(admin, { after: 'nope' })).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] }),
    );
    expect(await history(admin, { after: id<'Account'>(0x999) })).toEqual(
      err({ code: 'validation.failed', fields: [{ path: 'after', code: 'unknown' }] }),
    );
    for (const context of [actor('seller'), actor('customer')]) {
      expect((await history(context, {})).ok).toBe(false);
    }
  });

  it('lets only an admin read or set it: a seller, a customer, an anonymous caller and the system cannot', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'notif-anon-abcd');
    const system = testCallContext(market, 'system', 'notif-system-abcd');
    for (const context of [actor('seller'), actor('customer'), anonymous, system]) {
      expect((await set('help@example.com', context)).ok).toBe(false);
      expect((await view(context)).ok).toBe(false);
    }
    expect(contacts.rows).toEqual([]);
  });

  it('shows a visitor with no session the address only, the default and then the admin change', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'notif-anon-public');
    const publicView = () => new ViewPublicSupportContact(gate, deps).execute(anonymous, {});
    expect(await publicView()).toEqual(ok({ email: configured }));
    await set('Help@Example.com');
    expect(await publicView()).toEqual(ok({ email: 'help@example.com' }));
  });
});
