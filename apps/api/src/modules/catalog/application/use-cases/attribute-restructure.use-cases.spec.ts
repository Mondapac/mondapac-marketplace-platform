import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  claimLocalesOf,
  halalOnlyMatcher,
  MemoryAttributeDefinitionStore,
  MemoryAttributeRelaxationStore,
} from '../../../../../test/support/catalog-attribute-editor-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT, CATALOG_ATTRIBUTE_RESTRUCTURE } from '../../contracts/permissions';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { AttributeImpact, AttributeImpactReader } from '../ports/attribute-impact.reader';
import { AttributeArchive } from './attribute-archive.use-case';
import { AttributeArchiveRequestListOpen } from './attribute-archive-request-list-open.use-case';
import { AttributeRelaxationListOpen } from './attribute-relaxation-list-open.use-case';
import { AttributeArchiveConfirm } from './attribute-archive-confirm.use-case';
import { AttributeArchiveRequestCreate } from './attribute-archive-request.use-case';
import { AttributeDefinitionCreate } from './attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from './attribute-definition-edit.use-case';
import { AttributeDefinitionPublish } from './attribute-definition-publish.use-case';
import { AttributeImpactGet } from './attribute-impact-get.use-case';
import { AttributeConvert } from './attribute-convert.use-case';
import { AttributeMerge } from './attribute-merge.use-case';
import { AttributeValuesMerge } from './attribute-values-merge.use-case';

// Merging values, archiving and the archive of a material attribute by two administrators
// (attributes A8), in memory on both Market fixtures. The SQL and its guard trigger are in
// test/db/catalog-attribute-archive.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-04T10:00:00Z');
const FIRST = '01990000-0000-7000-8000-0000000000a1';
const SECOND = '01990000-0000-7000-8000-0000000000b1';
const none = { count: 0, atLeast: false };
const EMPTY: AttributeImpact = {
  publishedProducts: none,
  drafts: none,
  featureSetCount: 0,
  featureSets: [],
  categories: none,
  filters: none,
  liveVariantProducts: none,
};

describe.each(['AU', 'ZZ'] as const)('attribute restructure in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const english = policy.locales(market).default;

  const admin = (accountId: string): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: accountId as never,
        sessionId: `${accountId.slice(0, -2)}ff` as never,
        sellerId: null,
      }),
    );

  const actingAs = (): CallContext => {
    const base = admin(SECOND);
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: SECOND } } as never };
  };

  let store: MemoryAttributeDefinitionStore;
  let relaxations: MemoryAttributeRelaxationStore;
  let audits: AuditEntry[];
  let granted: string[];
  let impact: AttributeImpact;
  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => granted.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const impactReader: AttributeImpactReader = { impactOf: () => Promise.resolve(impact) };

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps = {
      unitOfWork,
      attributeStore: store,
      relaxations,
      impact: impactReader,
      policy,
      matcher: halalOnlyMatcher,
      claimLocales: claimLocalesOf(policy.locales(market).supported),
      audit,
      clock,
      ids,
    };
    return {
      create: new AttributeDefinitionCreate(gate, deps),
      edit: new AttributeDefinitionEdit(gate, deps),
      publish: new AttributeDefinitionPublish(gate, deps),
      get: new AttributeImpactGet(gate, deps),
      merge: new AttributeValuesMerge(gate, deps),
      mergeAttribute: new AttributeMerge(gate, deps),
      convert: new AttributeConvert(gate, deps),
      archive: new AttributeArchive(gate, deps),
      requestArchive: new AttributeArchiveRequestCreate(gate, deps),
      confirmArchive: new AttributeArchiveConfirm(gate, deps),
      listArchive: new AttributeArchiveRequestListOpen(gate, deps),
      listClear: new AttributeRelaxationListOpen(gate, deps),
    };
  };

  beforeEach(() => {
    store = new MemoryAttributeDefinitionStore();
    relaxations = new MemoryAttributeRelaxationStore();
    audits = [];
    granted = [CATALOG_ATTRIBUTE_EDIT.key, CATALOG_ATTRIBUTE_RESTRUCTURE.key];
    impact = EMPTY;
    clock.set(T0);
    ids = new SequenceIdGenerator(clock);
  });

  /** A published select attribute with three values, at version 2. */
  async function published(
    material = false,
    name = 'Pack type',
    dataType: 'select' | 'text' | 'integer' = 'select',
  ) {
    const uc = build();
    const created = await uc.create.execute(admin(FIRST), {
      dataType,
      names: { [english]: name },
      material,
      ...(dataType === 'select'
        ? {
            options: [
              { code: 'tin', labels: { [english]: 'Tin' } },
              { code: 'can', labels: { [english]: 'Can' } },
              { code: 'jar', labels: { [english]: 'Jar' } },
            ],
          }
        : {}),
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const done = await uc.publish.execute(admin(FIRST), {
      attributeId: created.value.attribute.id,
      version: created.value.attribute.version,
    });
    if (!done.ok) throw new Error(`publish failed: ${done.error.code}`);
    audits = [];
    return done.value.attribute;
  }

  describe('impact', () => {
    it('answers the impact with the attribute as the admin saw it', async () => {
      const attribute = await published(true);
      impact = { ...EMPTY, publishedProducts: { count: 10_000, atLeast: true } };
      const answer = await build().get.execute(admin(FIRST), { attributeId: attribute.id });
      expect(answer).toMatchObject({
        ok: true,
        value: {
          attribute: { id: attribute.id, version: attribute.version, material: true },
          impact: { publishedProducts: { count: 10_000, atLeast: true } },
        },
      });
    });

    it('needs the restructure key, not only the edit key', async () => {
      const attribute = await published();
      granted = [CATALOG_ATTRIBUTE_EDIT.key];
      expect(await build().get.execute(admin(FIRST), { attributeId: attribute.id })).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('merge values', () => {
    it('merges the source into the target as a new revision, with one audit row', async () => {
      const attribute = await published();
      const answer = await build().merge.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
        source: 'can',
        target: 'tin',
      });
      expect(answer).toMatchObject({ ok: true, value: { attribute: { revisionNo: 2 } } });
      const options = store.rows.get(attribute.id)!.state.options;
      expect(options.find((o) => o.code === 'can')).toMatchObject({
        active: false,
        mergedInto: 'tin',
      });
      expect(options.find((o) => o.code === 'tin')).toMatchObject({ active: true });
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.values-merged']);
    });

    it('keeps a chain one step long: values merged into the source follow it to the target', async () => {
      const attribute = await published();
      const uc = build();
      const first = await uc.merge.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
        source: 'jar',
        target: 'can',
      });
      if (!first.ok) throw new Error(first.error.code);
      const second = await uc.merge.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: first.value.attribute.version,
        source: 'can',
        target: 'tin',
      });
      expect(second.ok).toBe(true);
      const options = store.rows.get(attribute.id)!.state.options;
      expect(options.find((o) => o.code === 'jar')?.mergedInto).toBe('tin');
      expect(options.find((o) => o.code === 'can')?.mergedInto).toBe('tin');
    });

    it.each([
      ['a value into itself', 'tin', 'tin'],
      ['an unknown source', 'bottle', 'tin'],
      ['an unknown target', 'tin', 'bottle'],
    ])('refuses %s', async (_name, source, target) => {
      const attribute = await published();
      expect(
        await build().merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
          source,
          target,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-invalid' } });
    });

    it('refuses an already merged source and a merged target', async () => {
      const attribute = await published();
      const uc = build();
      const merged = await uc.merge.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
        source: 'can',
        target: 'tin',
      });
      if (!merged.ok) throw new Error(merged.error.code);
      const version = merged.value.attribute.version;
      expect(
        await uc.merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version,
          source: 'can',
          target: 'jar',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-invalid' } });
      expect(
        await uc.merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version,
          source: 'jar',
          target: 'can',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-invalid' } });
    });

    it('refuses a stale version, a draft and a text attribute', async () => {
      const attribute = await published();
      const uc = build();
      expect(
        await uc.merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version - 1,
          source: 'can',
          target: 'tin',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
      const draft = await uc.create.execute(admin(FIRST), {
        dataType: 'select',
        names: { [english]: 'Draft' },
        options: [
          { code: 'a', labels: { [english]: 'A' } },
          { code: 'b', labels: { [english]: 'B' } },
        ],
      });
      if (!draft.ok) throw new Error(draft.error.code);
      expect(
        await uc.merge.execute(admin(FIRST), {
          attributeId: draft.value.attribute.id,
          version: draft.value.attribute.version,
          source: 'a',
          target: 'b',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.not-published' } });
      const text = await uc.create.execute(admin(FIRST), {
        dataType: 'text',
        names: { [english]: 'Note' },
      });
      if (!text.ok) throw new Error(text.error.code);
      const live = await uc.publish.execute(admin(FIRST), {
        attributeId: text.value.attribute.id,
        version: text.value.attribute.version,
      });
      if (!live.ok) throw new Error(live.error.code);
      expect(
        await uc.merge.execute(admin(FIRST), {
          attributeId: live.value.attribute.id,
          version: live.value.attribute.version,
          source: 'a',
          target: 'b',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.not-select' } });
    });

    it('needs the restructure key and refuses unknown keys in the body', async () => {
      const attribute = await published();
      granted = [CATALOG_ATTRIBUTE_EDIT.key];
      expect(
        await build().merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
          source: 'can',
          target: 'tin',
        }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      granted = [CATALOG_ATTRIBUTE_RESTRUCTURE.key];
      expect(
        await build().merge.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
          source: 'can',
          target: 'tin',
          extra: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('does not let an edit bring a merged value back or switch off its target', async () => {
      const attribute = await published();
      const uc = build();
      const merged = await uc.merge.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
        source: 'can',
        target: 'tin',
      });
      if (!merged.ok) throw new Error(merged.error.code);
      const edit = (tinActive: boolean) =>
        uc.edit.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: merged.value.attribute.version,
          names: { [english]: 'Pack type' },
          options: [
            { code: 'tin', labels: { [english]: 'Tin' }, active: tinActive },
            { code: 'can', labels: { [english]: 'Can' }, active: true },
            { code: 'jar', labels: { [english]: 'Jar' }, active: true },
          ],
        });
      expect(await edit(false)).toMatchObject({
        ok: false,
        error: { code: 'attribute-definition.merge-invalid' },
      });
      expect(await edit(true)).toMatchObject({ ok: true });
      const can = store.rows.get(attribute.id)!.state.options.find((o) => o.code === 'can');
      expect(can).toMatchObject({ active: false, mergedInto: 'tin' });
    });
  });

  describe('archive', () => {
    it('archives a published attribute that is in no feature set, with one audit row', async () => {
      const attribute = await published();
      const answer = await build().archive.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
      });
      expect(answer).toMatchObject({ ok: true, value: { attribute: { status: 'archived' } } });
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.archived']);
    });

    it('is refused while an active feature set lists it', async () => {
      const attribute = await published();
      impact = { ...EMPTY, featureSetCount: 1 };
      expect(
        await build().archive.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.archive-blocked', fields: [{ code: 'in-feature-set' }] },
      });
      expect(store.rows.get(attribute.id)!.state.status).toBe('active');
    });

    it('is refused for a variant attribute with live variants', async () => {
      const uc = build();
      const created = await uc.create.execute(admin(FIRST), {
        dataType: 'select',
        names: { [english]: 'Size' },
        isVariantOption: true,
        options: [{ code: 'small', labels: { [english]: 'Small' } }],
      });
      if (!created.ok) throw new Error(created.error.code);
      const live = await uc.publish.execute(admin(FIRST), {
        attributeId: created.value.attribute.id,
        version: created.value.attribute.version,
      });
      if (!live.ok) throw new Error(live.error.code);
      impact = { ...EMPTY, liveVariantProducts: { count: 3, atLeast: false } };
      expect(
        await uc.archive.execute(admin(FIRST), {
          attributeId: live.value.attribute.id,
          version: live.value.attribute.version,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.archive-blocked', fields: [{ code: 'live-variants' }] },
      });
    });

    it('sends a material attribute to the two-person request', async () => {
      const attribute = await published(true);
      expect(
        await build().archive.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.archive-needs-second-admin' } });
    });

    it('refuses a draft and an archived attribute, and a stale version', async () => {
      const uc = build();
      const draft = await uc.create.execute(admin(FIRST), {
        dataType: 'text',
        names: { [english]: 'Draft' },
      });
      if (!draft.ok) throw new Error(draft.error.code);
      expect(
        await uc.archive.execute(admin(FIRST), {
          attributeId: draft.value.attribute.id,
          version: draft.value.attribute.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.not-published' } });
      const attribute = await published();
      expect(
        await uc.archive.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version - 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
      const done = await uc.archive.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
      });
      if (!done.ok) throw new Error(done.error.code);
      expect(
        await uc.archive.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: done.value.attribute.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.archived' } });
    });
  });

  describe('archive of a material attribute by two administrators', () => {
    async function requested() {
      const attribute = await published(true);
      const answer = await build().requestArchive.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
      });
      if (!answer.ok) throw new Error(`request failed: ${answer.error.code}`);
      audits = [];
      return { attribute, request: answer.value.request };
    }

    it('opens a 72-hour archive request and changes nothing yet', async () => {
      const attribute = await published(true);
      const answer = await build().requestArchive.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
      });
      expect(answer).toMatchObject({
        ok: true,
        value: { request: { kind: 'archive', status: 'open', expiresAt: '2026-11-07T10:00:00Z' } },
      });
      expect(store.rows.get(attribute.id)!.state.status).toBe('active');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-relaxation.requested']);
    });

    it('refuses a request for an attribute that is not material or cannot be archived', async () => {
      const plain = await published(false);
      expect(
        await build().requestArchive.execute(admin(FIRST), {
          attributeId: plain.id,
          version: plain.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.archive-not-material' } });
      const material = await published(true);
      impact = { ...EMPTY, featureSetCount: 2 };
      expect(
        await build().requestArchive.execute(admin(FIRST), {
          attributeId: material.id,
          version: material.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.archive-blocked' } });
    });

    it('allows one open request per attribute', async () => {
      const { attribute } = await requested();
      expect(
        await build().requestArchive.execute(admin(SECOND), {
          attributeId: attribute.id,
          version: attribute.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.already-open' } });
    });

    it('lists archive requests under the restructure key, apart from the clear-material list', async () => {
      const { request } = await requested();
      const listed = await build().listArchive.execute(admin(SECOND), {});
      expect(listed).toMatchObject({
        ok: true,
        value: { requests: [{ id: request.id, kind: 'archive', mine: false }] },
      });
      expect(await build().listClear.execute(admin(SECOND), {})).toEqual(ok({ requests: [] }));
      const own = await build().listArchive.execute(admin(FIRST), {});
      expect(own).toMatchObject({
        ok: true,
        value: {
          requests: [{ mine: true, allowedActions: { confirm: { allowed: false } } }],
        },
      });
    });

    it('does not list archive requests without the restructure key or in an acting-as session', async () => {
      await requested();
      granted = [CATALOG_ATTRIBUTE_EDIT.key];
      expect(await build().listArchive.execute(admin(SECOND), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      granted = [CATALOG_ATTRIBUTE_RESTRUCTURE.key];
      expect(await build().listArchive.execute(actingAs(), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('is archived by a second administrator, with both account ids audited', async () => {
      const { attribute, request } = await requested();
      const answer = await build().confirmArchive.execute(admin(SECOND), {
        requestId: request.id,
        version: request.version,
      });
      expect(answer).toMatchObject({
        ok: true,
        value: { request: { status: 'confirmed' }, attribute: { status: 'archived' } },
      });
      expect(store.rows.get(attribute.id)!.state.status).toBe('archived');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'catalog.attribute-definition.archived',
        after: { status: 'archived', requestedByAccountId: FIRST },
      });
    });

    it('is not archived by the requester, after 72 hours, or when it joined a feature set since', async () => {
      const { request } = await requested();
      expect(
        await build().confirmArchive.execute(admin(FIRST), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.same-admin' } });
      impact = { ...EMPTY, featureSetCount: 1 };
      expect(
        await build().confirmArchive.execute(admin(SECOND), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.archive-blocked' } });
      impact = EMPTY;
      clock.set(T0.add({ hours: 72 }));
      expect(
        await build().confirmArchive.execute(admin(SECOND), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.expired' } });
    });

    it('answers not-found for a request that does not exist', async () => {
      expect(
        await build().confirmArchive.execute(admin(SECOND), {
          requestId: '01990000-0000-7000-8000-00000000ffff',
          version: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.not-found' } });
    });

    it('is cancelled by a merge of values, which changes the version it named', async () => {
      const { attribute, request } = await requested();
      const merged = await build().merge.execute(admin(SECOND), {
        attributeId: attribute.id,
        version: attribute.version,
        source: 'can',
        target: 'tin',
      });
      expect(merged.ok).toBe(true);
      expect(relaxations.rows.get(request.id)!.state).toMatchObject({
        status: 'cancelled',
        cancelReason: 'definition-changed',
      });
    });
  });
  describe('acting as a seller', () => {
    it('refuses every restructure use case in an acting-as session', async () => {
      const source = await published(false, 'Pack type');
      const target = await published(false, 'Container');
      const uc = build();
      const refused = { ok: false, error: { code: 'access.denied' } };
      expect(await uc.get.execute(actingAs(), { attributeId: source.id })).toMatchObject(refused);
      expect(
        await uc.archive.execute(actingAs(), { attributeId: source.id, version: source.version }),
      ).toMatchObject(refused);
      expect(
        await uc.mergeAttribute.execute(actingAs(), {
          attributeId: source.id,
          version: source.version,
          target: target.id,
          targetVersion: target.version,
          options: { tin: 'tin', can: 'can', jar: 'jar' },
        }),
      ).toMatchObject(refused);
      expect(
        await uc.convert.execute(actingAs(), {
          attributeId: source.id,
          version: source.version,
          to: 'multi-select',
        }),
      ).toMatchObject(refused);
      expect(store.rows.get(source.id)!.state.dataType).toBe('select');
      expect(
        await uc.requestArchive.execute(actingAs(), {
          attributeId: source.id,
          version: source.version,
        }),
      ).toMatchObject(refused);
      expect(store.rows.get(source.id)!.state.status).toBe('active');
      expect(store.merges).toEqual([]);
    });
  });

  describe('merge attributes', () => {
    async function pair() {
      const source = await published(false, 'Pack type');
      const target = await published(false, 'Container');
      return { source, target };
    }
    const mergeInput = (
      source: { id: string; version: number },
      target: { id: string; version: number },
      options?: Record<string, string>,
    ) => ({
      attributeId: source.id,
      version: source.version,
      target: target.id,
      targetVersion: target.version,
      ...(options === undefined ? {} : { options }),
    });
    const all = { tin: 'tin', can: 'can', jar: 'jar' };

    it('archives the source, points it at the target and maps every value, with one audit row', async () => {
      const { source, target } = await pair();
      const answer = await build().mergeAttribute.execute(
        admin(FIRST),
        mergeInput(source, target, all),
      );
      expect(answer).toMatchObject({ ok: true, value: { attribute: { status: 'archived' } } });
      expect(store.rows.get(source.id)!.state.status).toBe('archived');
      expect(store.merges).toEqual([
        {
          source: source.id,
          target: target.id,
          options: [
            { sourceCode: 'tin', targetCode: 'tin' },
            { sourceCode: 'can', targetCode: 'can' },
            { sourceCode: 'jar', targetCode: 'jar' },
          ],
        },
      ]);
      expect(store.rows.get(target.id)!.state.status).toBe('active');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.merged']);
    });

    it('needs the restructure key, not only the edit key', async () => {
      const { source, target } = await pair();
      granted = [CATALOG_ATTRIBUTE_EDIT.key];
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, target, all)),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(store.merges).toEqual([]);
    });

    it('names the value that has no target value', async () => {
      const { source, target } = await pair();
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput(source, target, { tin: 'tin', can: 'can' }),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'attribute-definition.merge-unmapped',
          fields: [{ path: 'options.jar', code: 'unmapped' }],
        },
      });
      expect(store.rows.get(source.id)!.state.status).toBe('active');
    });

    it('refuses a target value that does not exist or is not active', async () => {
      const { source, target } = await pair();
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput(source, target, { ...all, jar: 'tub' }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-unmapped' } });
    });

    it('refuses attributes of different types', async () => {
      const source = await published(false, 'Pack type');
      const target = await published(false, 'Note', 'text');
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, target, all)),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-type-mismatch' } });
    });

    it('merges a type without values with no map', async () => {
      const source = await published(false, 'Remark', 'text');
      const target = await published(false, 'Note', 'text');
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, target)),
      ).toMatchObject({ ok: true });
      expect(store.merges[0]?.options).toEqual([]);
    });

    it('refuses an attribute merged into itself', async () => {
      const { source } = await pair();
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, source, all)),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-invalid' } });
    });

    it('refuses a material source and a target that is archived', async () => {
      const material = await published(true, 'Origin');
      const target = await published(false, 'Container');
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(material, target, all)),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-material' } });
      const source = await published(false, 'Pack type');
      const archived = await build().archive.execute(admin(FIRST), {
        attributeId: target.id,
        version: target.version,
      });
      expect(archived.ok).toBe(true);
      const gone = store.rows.get(target.id)!.state;
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput(source, { id: target.id, version: gone.version }, all),
        ),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-invalid' } });
    });

    it('refuses a material target, which a merge cannot protect with a second administrator', async () => {
      const source = await published(false, 'Pack type');
      const target = await published(true, 'Container');
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, target, all)),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.merge-material' } });
      expect(store.merges).toEqual([]);
    });

    it('keeps a chain one step long: an attribute others were merged into is neither merged nor archived', async () => {
      const first = await published(false, 'Pack type');
      const middle = await published(false, 'Container');
      const end = await published(false, 'Vessel');
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(first, middle, all)),
      ).toMatchObject({ ok: true });
      const again = store.rows.get(middle.id)!.state;
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput({ id: middle.id, version: again.version }, end, all),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.merge-blocked', fields: [{ code: 'merge-target' }] },
      });
      expect(
        await build().archive.execute(admin(FIRST), {
          attributeId: middle.id,
          version: again.version,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.archive-blocked', fields: [{ code: 'merge-target' }] },
      });
      expect(store.rows.get(middle.id)!.state.status).toBe('active');
      expect(store.merges).toHaveLength(1);
    });

    it('is refused while an active feature set lists the source', async () => {
      const { source, target } = await pair();
      impact = { ...EMPTY, featureSetCount: 1 };
      expect(
        await build().mergeAttribute.execute(admin(FIRST), mergeInput(source, target, all)),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.merge-blocked', fields: [{ code: 'in-feature-set' }] },
      });
      expect(store.rows.get(source.id)!.state.status).toBe('active');
    });

    it('is refused for a variant attribute with live variants', async () => {
      const { target } = await pair();
      const uc = build();
      const created = await uc.create.execute(admin(FIRST), {
        dataType: 'select',
        names: { [english]: 'Size' },
        isVariantOption: true,
        options: [
          { code: 'tin', labels: { [english]: 'Small' } },
          { code: 'can', labels: { [english]: 'Medium' } },
          { code: 'jar', labels: { [english]: 'Large' } },
        ],
      });
      if (!created.ok) throw new Error(created.error.code);
      const live = await uc.publish.execute(admin(FIRST), {
        attributeId: created.value.attribute.id,
        version: created.value.attribute.version,
      });
      if (!live.ok) throw new Error(live.error.code);
      impact = { ...EMPTY, liveVariantProducts: { count: 3, atLeast: false } };
      expect(
        await uc.mergeAttribute.execute(
          admin(FIRST),
          mergeInput(live.value.attribute, target, all),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute.merge-blocked', fields: [{ code: 'live-variants' }] },
      });
    });

    it('answers stale when either attribute changed since the dialog', async () => {
      const { source, target } = await pair();
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput(source, { id: target.id, version: target.version + 1 }, all),
        ),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
      expect(
        await build().mergeAttribute.execute(
          admin(FIRST),
          mergeInput({ id: source.id, version: source.version - 1 }, target, all),
        ),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
    });

    it('refuses an unknown field and a target that is not an id', async () => {
      const { source, target } = await pair();
      expect(
        await build().mergeAttribute.execute(admin(FIRST), {
          ...mergeInput(source, target, all),
          extra: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await build().mergeAttribute.execute(admin(FIRST), {
          ...mergeInput(source, target, all),
          target: 'x',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('convert type', () => {
    const convertInput = (attribute: { id: string; version: number }, to: string) => ({
      attributeId: attribute.id,
      version: attribute.version,
      to,
    });

    it('turns a select into a multi-select as a new revision, with one audit row', async () => {
      const select = await published(false, 'Pack type');
      const answer = await build().convert.execute(
        admin(FIRST),
        convertInput(select, 'multi-select'),
      );
      expect(answer).toMatchObject({
        ok: true,
        value: { attribute: { version: select.version + 1, revisionNo: 2 } },
      });
      expect(store.rows.get(select.id)!.state.dataType).toBe('multi-select');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.converted']);
    });

    it('turns a whole number into a decimal', async () => {
      const number = await published(false, 'Servings', 'integer');
      const answer = await build().convert.execute(admin(FIRST), convertInput(number, 'decimal'));
      expect(answer).toMatchObject({ ok: true, value: { attribute: { status: 'active' } } });
      expect(store.rows.get(number.id)!.state.dataType).toBe('decimal');
    });

    it('refuses a path that is not listed, and a text attribute', async () => {
      const select = await published(false, 'Pack type');
      const text = await published(false, 'Note', 'text');
      expect(
        await build().convert.execute(admin(FIRST), convertInput(select, 'text')),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.convert-invalid' } });
      expect(
        await build().convert.execute(admin(FIRST), convertInput(text, 'select')),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.convert-invalid' } });
      expect(audits).toEqual([]);
    });

    it('refuses a material attribute, a stale version and an unknown field', async () => {
      const material = await published(true, 'Heat');
      const select = await published(false, 'Pack type');
      expect(
        await build().convert.execute(admin(FIRST), convertInput(material, 'multi-select')),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.convert-material' } });
      expect(
        await build().convert.execute(admin(FIRST), {
          ...convertInput(select, 'multi-select'),
          version: select.version + 5,
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
      expect(
        await build().convert.execute(admin(FIRST), {
          ...convertInput(select, 'multi-select'),
          extra: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('refuses an attribute that others were merged into', async () => {
      const source = await published(false, 'Pack type');
      const target = await published(false, 'Container');
      const merged = await build().mergeAttribute.execute(admin(FIRST), {
        attributeId: source.id,
        version: source.version,
        target: target.id,
        targetVersion: target.version,
        options: { tin: 'tin', can: 'can', jar: 'jar' },
      });
      expect(merged.ok).toBe(true);
      expect(
        await build().convert.execute(admin(FIRST), convertInput(target, 'multi-select')),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.convert-merged' } });
    });

    it('needs the restructure key, not only the edit key', async () => {
      const select = await published(false, 'Pack type');
      granted = [CATALOG_ATTRIBUTE_EDIT.key];
      expect(
        await build().convert.execute(admin(FIRST), convertInput(select, 'multi-select')),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(store.rows.get(select.id)!.state.dataType).toBe('select');
    });
  });
});
