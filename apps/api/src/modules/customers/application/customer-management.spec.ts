import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerListRow } from '../domain/customer-list';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import type { IdentityManagementPeer } from './ports/customer-management-peers';
import type { SheetWriter } from './ports/sheet-writer';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import {
  FakeNoteCipher,
  InMemoryCustomerGroups,
  InMemoryCustomerNotes,
  InMemoryCustomerTimeline,
} from './testing/in-memory-customer-management';
import { AdminCustomerGroupCreate } from './use-cases/admin-customer-group-create.use-case';
import { AdminCustomerGroupMembersAdd } from './use-cases/admin-customer-group-members-add.use-case';
import { AdminCustomerGroupMembersRemove } from './use-cases/admin-customer-group-members-remove.use-case';
import { AdminCustomerGroupUpdate } from './use-cases/admin-customer-group-update.use-case';
import { AdminCustomerGroupView } from './use-cases/admin-customer-group-view.use-case';
import { AdminCustomerGroupsList } from './use-cases/admin-customer-groups-list.use-case';
import { AdminCustomerNoteAdd } from './use-cases/admin-customer-note-add.use-case';
import { AdminCustomerNotesList } from './use-cases/admin-customer-notes-list.use-case';
import { AdminCustomerRename } from './use-cases/admin-customer-rename.use-case';
import { AdminCustomerTimeline } from './use-cases/admin-customer-timeline.use-case';
import { AdminCustomerTimelineExport } from './use-cases/admin-customer-timeline-export.use-case';
import { ReadCustomerGroupMembership } from './use-cases/read-customer-group-membership.use-case';

// Customers management phase 2 (PR 2a) in memory, on both Market fixtures: manual groups (access
// keys, names unique whatever the case, versions, archive, members by ids and by "select all
// matching", caps, audit rows and timeline entries), the membership read promotions asks, admin
// notes (sealed, paged, a destroyed key), the activity timeline (filters, paging, the page-open
// audit row, the export behind a step-up) and the admin rename through identity.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-15T12:00:00Z');
const VIEW = 'customers.customers.view';
const MANAGE = 'customers.groups.manage';
const NOTES = 'customers.customer-notes.write';
const EDIT = 'customers.customers.edit';
const EXPORT = 'customers.customers.export';

describe.each(['AU', 'ZZ'] as const)('customers management in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(NOW);
  const ids = new SequenceIdGenerator(clock);

  const row = (overrides: Partial<CustomerListRow> = {}): CustomerListRow => ({
    accountId: ids.next<'Account'>(),
    email: `${ids.next<'Account'>()}@example.test`,
    groups: [],
    displayName: null,
    status: 'active',
    emailVerified: true,
    signedUpAt: NOW.subtract({ hours: 24 * 30 }),
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
    ...overrides,
  });

  function setup() {
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        if (declaration.rule.kind === 'system') {
          return Promise.resolve(
            actor.kind === 'system'
              ? { allowed: true }
              : { allowed: false, denial: { code: 'access.denied' } },
          );
        }
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const listReader = new InMemoryCustomerList();
    const groups = new InMemoryCustomerGroups(listReader);
    const notes = new InMemoryCustomerNotes();
    const noteCipher = new FakeNoteCipher();
    const timeline = new InMemoryCustomerTimeline(listReader);
    const stepUp = { refuse: null as null | 'second-factor.required' };
    const consumer: StepUpProofConsumer = {
      consume: (_context: CallContext, actionKey: string) =>
        Promise.resolve(
          stepUp.refuse !== null
            ? err({ code: stepUp.refuse, actionKey })
            : ok({ sessionId: ids.next<'Session'>(), verifiedAt: NOW }),
        ),
    };
    const sheetWriter: SheetWriter = {
      xlsx: async function* (_name, rows) {
        for await (const r of rows) yield new TextEncoder().encode(r.join('\t') + '\n');
      },
    };
    const renames: { accountId: string; displayName: string }[] = [];
    const identity: IdentityManagementPeer = {
      renameCustomerForAdmin: (_context, input) => {
        renames.push(input);
        return Promise.resolve(ok({ changed: true }));
      },
      changeActors: (_context, accountIds) =>
        Promise.resolve(
          ok(accountIds.map((accountId) => ({ accountId, displayName: 'Admin One' }))),
        ),
    };
    const deps: CustomerManagementDependencies = {
      unitOfWork,
      groups,
      notes,
      noteCipher,
      timeline,
      listReader,
      audit,
      clock,
      ids,
      stepUp: consumer,
      sheetWriter,
      identity,
    };
    const admin = (keys: readonly string[], inMarket: MarketContext = market) => {
      const accountId = ids.next<'Account'>();
      held.set(accountId, keys);
      return {
        accountId,
        context: testCallContext(
          inMarket,
          testAuthenticatedActor(inMarket, {
            population: 'admin',
            accountId,
            sessionId: ids.next<'Session'>(),
            sellerId: null,
          }),
        ),
      };
    };
    return {
      deps,
      audits,
      listReader,
      groups,
      notes,
      noteCipher,
      timeline,
      stepUp,
      renames,
      admin,
      system: testCallContext(market, 'system'),
      create: new AdminCustomerGroupCreate(gate, deps),
      update: new AdminCustomerGroupUpdate(gate, deps),
      view: new AdminCustomerGroupView(gate, deps),
      list: new AdminCustomerGroupsList(gate, deps),
      add: new AdminCustomerGroupMembersAdd(gate, deps),
      remove: new AdminCustomerGroupMembersRemove(gate, deps),
      membership: new ReadCustomerGroupMembership(gate, deps),
      addNote: new AdminCustomerNoteAdd(gate, deps),
      listNotes: new AdminCustomerNotesList(gate, deps),
      readTimeline: new AdminCustomerTimeline(gate, deps),
      exportTimeline: new AdminCustomerTimelineExport(gate, deps),
      rename: new AdminCustomerRename(gate, deps),
    };
  }

  const failure = (result: Result<unknown, { code: string }>) =>
    result.ok ? 'ok' : result.error.code;

  async function collect(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
    let text = '';
    for await (const chunk of chunks) {
      text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    }
    return text;
  }

  describe('manual groups', () => {
    it('needs the view and manage keys to change a group, and view to read one', async () => {
      const t = setup();
      const viewer = t.admin([VIEW]);
      const manager = t.admin([VIEW, MANAGE]);
      expect(failure(await t.create.execute(viewer.context, { name: 'VIP' }))).toBe(
        'access.denied',
      );
      const made = await t.create.execute(manager.context, { name: 'VIP' });
      expect(failure(made)).toBe('ok');
      expect(failure(await t.list.execute(viewer.context, {}))).toBe('ok');
      expect(failure(await t.list.execute(t.admin([]).context, {}))).toBe('access.denied');
    });

    it('keeps names unique whatever their case, audits the create, and caps nothing else', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const made = await t.create.execute(manager.context, {
        name: '  Wholesale buyers ',
        description: 'Cafés',
      });
      expect(made.ok && made.value.name).toBe('Wholesale buyers');
      expect(failure(await t.create.execute(manager.context, { name: 'WHOLESALE BUYERS' }))).toBe(
        'customers.group-name-taken',
      );
      expect(failure(await t.create.execute(manager.context, { name: 'x‮y' }))).toBe(
        'validation.failed',
      );
      expect(failure(await t.create.execute(manager.context, { name: 'a', extra: 1 }))).toBe(
        'validation.failed',
      );
      expect(t.audits.map((entry) => entry.action)).toEqual(['customers.customer-group.created']);
      expect(JSON.stringify(t.audits)).not.toContain('Wholesale');
    });

    it('renames and archives under the version read; a stale version is a conflict', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const made = await t.create.execute(manager.context, { name: 'VIP' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      const renamed = await t.update.execute(manager.context, {
        groupId,
        expectedVersion: 1,
        name: 'Gold',
      });
      expect(renamed.ok && [renamed.value.name, renamed.value.version]).toEqual(['Gold', 2]);
      expect(
        failure(
          await t.update.execute(manager.context, { groupId, expectedVersion: 1, name: 'X' }),
        ),
      ).toBe('customers.conflict');
      const archived = await t.update.execute(manager.context, {
        groupId,
        expectedVersion: 2,
        archived: true,
      });
      expect(archived.ok && archived.value.archived).toBe(true);
    });

    it('adds and removes members by ids, skipping ids that are no customer of the Market', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const a = row();
      const b = row();
      const foreign = row();
      t.listReader.add(market, a, b);
      t.listReader.add(otherMarket, foreign);
      const made = await t.create.execute(manager.context, { name: 'VIP' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      const added = await t.add.execute(manager.context, {
        groupId,
        ids: [a.accountId, b.accountId, foreign.accountId],
      });
      expect(added.ok && added.value).toEqual({ changed: 2, requested: 3 });
      const again = await t.add.execute(manager.context, { groupId, ids: [a.accountId] });
      expect(again.ok && again.value.changed).toBe(0);
      const viewed = await t.view.execute(manager.context, { groupId });
      expect(viewed.ok && viewed.value.memberCount).toBe(2);
      // The list rows carry the group (the `groups` column and the `group` filter).
      const [listed] = await t.listReader.rowsByIds(market, [a.accountId]);
      expect(listed!.groups.map((group) => group.name)).toEqual(['VIP']);
      const removed = await t.remove.execute(manager.context, { groupId, ids: [a.accountId] });
      expect(removed.ok && removed.value.changed).toBe(1);
      expect(
        t.audits.filter((e) => e.action === 'customers.customer-group.members-changed'),
      ).toHaveLength(2);
      const kinds = [...t.timeline.entries.values()].flat().map((entry) => entry.kind);
      expect(kinds.sort()).toEqual(['group-added', 'group-added', 'group-removed']);
      expect(t.timeline.entries.has(`${otherMarket.marketId}:${foreign.accountId}`)).toBe(false);
    });

    it('adds every customer that matches the filters, and refuses ids with filters', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      t.listReader.add(market, row({ status: 'disabled' }), row(), row());
      const made = await t.create.execute(manager.context, { name: 'Lapsed' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      const added = await t.add.execute(manager.context, {
        groupId,
        view: 'all',
        filters: { status: 'active' },
      });
      expect(added.ok && added.value).toEqual({ changed: 2, requested: 2 });
      expect(
        failure(await t.add.execute(manager.context, { groupId, ids: [ids.next()], view: 'all' })),
      ).toBe('validation.failed');
    });

    it('refuses new members for an archived group and another Market’s group', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const customer = row();
      t.listReader.add(market, customer);
      const made = await t.create.execute(manager.context, { name: 'Old' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      await t.update.execute(manager.context, { groupId, expectedVersion: 1, archived: true });
      expect(
        failure(await t.add.execute(manager.context, { groupId, ids: [customer.accountId] })),
      ).toBe('customers.group-archived');
      const elsewhere = t.admin([VIEW, MANAGE], otherMarket);
      expect(failure(await t.view.execute(elsewhere.context, { groupId }))).toBe(
        'customers.group-not-found',
      );
    });

    it('answers membership to the system actor only; an archived group has no members', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const customer = row();
      t.listReader.add(market, customer);
      const made = await t.create.execute(manager.context, { name: 'VIP' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      await t.add.execute(manager.context, { groupId, ids: [customer.accountId] });
      const ask = (context: CallContext) =>
        t.membership.execute(context, { groupId, accountId: customer.accountId });
      const yes = await ask(t.system);
      expect(yes.ok && yes.value.member).toBe(true);
      expect(failure(await ask(manager.context))).toBe('access.denied');
      await t.update.execute(manager.context, { groupId, expectedVersion: 1, archived: true });
      const archived = await ask(t.system);
      expect(archived.ok && archived.value.member).toBe(false);
      expect(
        failure(
          await t.membership.execute(t.system, {
            groupId: ids.next(),
            accountId: customer.accountId,
          }),
        ),
      ).toBe('customers.group-not-found');
      expect(failure(await t.membership.execute(t.system, { groupId: 'x', accountId: 'y' }))).toBe(
        'validation.failed',
      );
    });
  });

  describe('limits and failure paths', () => {
    it('refuses more than 1,000 ids, and a name taken on a rename', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const one = await t.create.execute(manager.context, { name: 'One' });
      const two = await t.create.execute(manager.context, { name: 'Two' });
      if (!one.ok || !two.ok) throw new Error('create failed');
      const many = Array.from({ length: 1001 }, () => ids.next<'Account'>());
      const tooMany = await t.add.execute(manager.context, {
        groupId: one.value.groupId,
        ids: many,
      });
      expect(tooMany.ok ? 'ok' : tooMany.error).toEqual({ code: 'batch.too-large', max: 1000 });
      expect(
        failure(
          await t.update.execute(manager.context, {
            groupId: two.value.groupId,
            expectedVersion: 1,
            name: 'one',
          }),
        ),
      ).toBe('customers.group-name-taken');
    });

    it('writes nothing for an update that changes nothing, and lets members leave an archived group', async () => {
      const t = setup();
      const manager = t.admin([VIEW, MANAGE]);
      const customer = row();
      t.listReader.add(market, customer);
      const made = await t.create.execute(manager.context, { name: 'Same' });
      if (!made.ok) throw new Error('create failed');
      const groupId = made.value.groupId;
      await t.add.execute(manager.context, { groupId, ids: [customer.accountId] });
      const before = t.audits.length;
      const same = await t.update.execute(manager.context, {
        groupId,
        expectedVersion: 1,
        name: 'Same',
      });
      expect(same.ok && same.value.version).toBe(1);
      expect(t.audits).toHaveLength(before);
      await t.update.execute(manager.context, { groupId, expectedVersion: 1, archived: true });
      const removed = await t.remove.execute(manager.context, {
        groupId,
        ids: [customer.accountId],
      });
      expect(removed.ok && removed.value.changed).toBe(1);
    });

    it('refuses a day that does not exist, a bad cursor and a limit out of range', async () => {
      const t = setup();
      const viewer = t.admin([VIEW]);
      const customer = row();
      t.listReader.add(market, customer);
      for (const from of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-1-1']) {
        expect(
          failure(
            await t.readTimeline.execute(viewer.context, {
              accountId: customer.accountId,
              filters: { from },
            }),
          ),
        ).toBe('validation.failed');
      }
      expect(
        failure(
          await t.readTimeline.execute(viewer.context, {
            accountId: customer.accountId,
            filters: { from: '2028-02-29' },
          }),
        ),
      ).toBe('ok');
      expect(
        failure(
          await t.listNotes.execute(viewer.context, { accountId: customer.accountId, cursor: 'x' }),
        ),
      ).toBe('validation.failed');
      expect(
        failure(
          await t.listNotes.execute(viewer.context, { accountId: customer.accountId, limit: 101 }),
        ),
      ).toBe('validation.failed');
    });

    it('exports the timeline as XLSX', async () => {
      const t = setup();
      const exporter = t.admin([VIEW, EXPORT]);
      const customer = row();
      t.listReader.add(market, customer);
      const file = await t.exportTimeline.execute(exporter.context, {
        accountId: customer.accountId,
        format: 'xlsx',
      });
      expect(file.ok && file.value.filename).toMatch(/\.xlsx$/);
    });
  });

  describe('notes', () => {
    it('seals the text, pages newest first, and audits only id and length', async () => {
      const t = setup();
      const writer = t.admin([VIEW, NOTES]);
      const reader = t.admin([VIEW]);
      const customer = row();
      t.listReader.add(market, customer);
      expect(
        failure(
          await t.addNote.execute(reader.context, { accountId: customer.accountId, body: 'x' }),
        ),
      ).toBe('access.denied');
      for (const body of ['first', 'second', 'third']) {
        clock.advance(Temporal.Duration.from({ seconds: 1 }));
        const added = await t.addNote.execute(writer.context, {
          accountId: customer.accountId,
          body,
        });
        expect(added.ok && added.value.byYou).toBe(true);
      }
      const stored = [...t.notes.notes.values()].flat();
      expect(stored.every((note) => !note.bodySealed.includes('first'))).toBe(true);
      const page = await t.listNotes.execute(reader.context, {
        accountId: customer.accountId,
        limit: 2,
      });
      if (!page.ok) throw new Error('list failed');
      expect(page.value.items.map((note) => note.body)).toEqual(['third', 'second']);
      expect(page.value.total).toBe(3);
      expect(page.value.items[0]!.authorName).toBe('Admin One');
      const next = await t.listNotes.execute(reader.context, {
        accountId: customer.accountId,
        cursor: page.value.nextCursor,
      });
      expect(next.ok && next.value.items.map((note) => note.body)).toEqual(['first']);
      expect(next.ok && next.value.nextCursor).toBeNull();
      const noted = t.audits.filter((entry) => entry.action === 'customers.customer-note.added');
      expect(noted).toHaveLength(3);
      expect(JSON.stringify(t.audits)).not.toContain('second');
    });

    it('shows a note without its text once the key is destroyed, and refuses new notes', async () => {
      const t = setup();
      const writer = t.admin([VIEW, NOTES]);
      const customer = row();
      t.listReader.add(market, customer);
      await t.addNote.execute(writer.context, { accountId: customer.accountId, body: 'call back' });
      t.noteCipher.destroy(market, customer.accountId);
      const page = await t.listNotes.execute(writer.context, { accountId: customer.accountId });
      expect(page.ok && page.value.items.map((note) => note.body)).toEqual([null]);
      expect(
        failure(
          await t.addNote.execute(writer.context, { accountId: customer.accountId, body: 'x' }),
        ),
      ).toBe('customers.customer-not-found');
    });

    it('treats another Market’s customer as not found', async () => {
      const t = setup();
      const writer = t.admin([VIEW, NOTES]);
      const foreign = row();
      t.listReader.add(otherMarket, foreign);
      // Only the foreign customer holds a key (in its own Market): the key is never touched here.
      t.noteCipher.keyed = new Set([`${otherMarket.marketId}:${foreign.accountId}`]);
      expect(
        failure(await t.addNote.execute(writer.context, { accountId: ids.next(), body: 'x' })),
      ).toBe('customers.customer-not-found');
      expect(
        failure(
          await t.addNote.execute(writer.context, { accountId: foreign.accountId, body: 'x' }),
        ),
      ).toBe('customers.customer-not-found');
      expect(
        failure(await t.listNotes.execute(writer.context, { accountId: foreign.accountId })),
      ).toBe('customers.customer-not-found');
    });
  });

  describe('activity timeline', () => {
    async function withEntries() {
      const t = setup();
      const customer = row();
      t.listReader.add(market, customer);
      const at = (days: number) => NOW.subtract({ hours: 24 * days });
      const entry = (kind: 'signed-up' | 'order-paid' | 'note-added', days: number) => ({
        id: ids.next<'CustomerTimelineEntry'>(),
        accountId: customer.accountId,
        occurredAt: at(days),
        kind,
        ref: kind === 'order-paid' ? { type: 'order' as const, id: ids.next() } : null,
        actorAccountId: null,
        detail: null,
        sourceEventId: kind === 'note-added' ? null : ids.next(),
      });
      await t.timeline.recordMany(
        market,
        [
          entry('signed-up', 30),
          entry('order-paid', 10),
          entry('order-paid', 2),
          entry('note-added', 1),
        ],
        NOW,
      );
      return { t, customer };
    }

    it('filters by category and date, pages with a total, and audits the page open', async () => {
      const { t, customer } = await withEntries();
      const viewer = t.admin([VIEW]);
      const all = await t.readTimeline.execute(viewer.context, { accountId: customer.accountId });
      expect(all.ok && all.value.items.map((item) => item.kind)).toEqual([
        'note-added',
        'order-paid',
        'order-paid',
        'signed-up',
      ]);
      const orders = await t.readTimeline.execute(viewer.context, {
        accountId: customer.accountId,
        filters: {
          category: 'orders',
          from: NOW.subtract({ hours: 24 * 5 })
            .toString()
            .slice(0, 10),
        },
      });
      expect(orders.ok && orders.value.items.map((item) => item.kind)).toEqual(['order-paid']);
      const paged = await t.readTimeline.execute(viewer.context, {
        accountId: customer.accountId,
        pageSize: 2,
        direction: 'asc',
      });
      expect(paged.ok && paged.value.items.map((item) => item.kind)).toEqual([
        'signed-up',
        'order-paid',
      ]);
      expect(
        failure(
          await t.readTimeline.execute(viewer.context, {
            accountId: customer.accountId,
            filters: { kinds: ['nope'] },
          }),
        ),
      ).toBe('validation.failed');
      const opened = t.audits.filter((entry) => entry.action === 'customers.customer-page.opened');
      expect(opened).toHaveLength(3);
    });

    it('exports behind a fresh step-up and the export key, without names of customers', async () => {
      const { t, customer } = await withEntries();
      const viewer = t.admin([VIEW]);
      const exporter = t.admin([VIEW, EXPORT]);
      expect(
        failure(await t.exportTimeline.execute(viewer.context, { accountId: customer.accountId })),
      ).toBe('access.denied');
      t.stepUp.refuse = 'second-factor.required';
      expect(
        failure(
          await t.exportTimeline.execute(exporter.context, { accountId: customer.accountId }),
        ),
      ).toBe('second-factor.required');
      t.stepUp.refuse = null;
      const file = await t.exportTimeline.execute(exporter.context, {
        accountId: customer.accountId,
      });
      if (!file.ok) throw new Error('export failed');
      expect(file.value.filename).toMatch(/^customer-activity-\d{4}-\d{2}-\d{2}\.csv$/);
      const text = await collect(file.value.chunks);
      expect(text.split('\r\n').filter((line) => line !== '')).toHaveLength(5);
      const exported = t.audits.find(
        (entry) => entry.action === 'customers.customer-timeline.exported',
      );
      expect(exported).toBeDefined();
    });
  });

  describe('rename by an admin', () => {
    it('needs the edit key, goes through identity and lands on the timeline', async () => {
      const t = setup();
      const editor = t.admin([VIEW, EDIT]);
      const viewer = t.admin([VIEW]);
      const customer = row();
      t.listReader.add(market, customer);
      expect(
        failure(
          await t.rename.execute(viewer.context, {
            accountId: customer.accountId,
            displayName: 'A',
          }),
        ),
      ).toBe('access.denied');
      const renamed = await t.rename.execute(editor.context, {
        accountId: customer.accountId,
        displayName: 'Amina Y',
      });
      expect(failure(renamed)).toBe('ok');
      expect(t.renames).toEqual([{ accountId: customer.accountId, displayName: 'Amina Y' }]);
      const kinds = (t.timeline.entries.get(`${market.marketId}:${customer.accountId}`) ?? []).map(
        (entry) => entry.kind,
      );
      expect(kinds).toEqual(['renamed-by-admin']);
      const foreign = row();
      t.listReader.add(otherMarket, foreign);
      expect(
        failure(
          await t.rename.execute(editor.context, {
            accountId: foreign.accountId,
            displayName: 'B',
          }),
        ),
      ).toBe('customers.customer-not-found');
    });
  });
});
