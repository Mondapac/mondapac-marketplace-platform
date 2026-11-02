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
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeRelaxationRequest } from '../../domain/attribute-relaxation-request';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { AttributeDefinitionCreate } from './attribute-definition-create.use-case';
import { AttributeDefinitionEdit } from './attribute-definition-edit.use-case';
import { AttributeDefinitionPublish } from './attribute-definition-publish.use-case';
import { AttributeRelaxationCancel } from './attribute-relaxation-cancel.use-case';
import { AttributeRelaxationConfirm } from './attribute-relaxation-confirm.use-case';
import { AttributeRelaxationListOpen } from './attribute-relaxation-list-open.use-case';
import { AttributeRelaxationRequestCreate } from './attribute-relaxation-request.use-case';
import { ExpireRelaxationRequests } from './expire-relaxation-requests.use-case';

// The two-person request to clear `material` (catalog design 8.2; attributes A2 part 3), in
// memory on both Market fixtures: who may ask, confirm and cancel; the 72-hour expiry by the
// unit's own clock and by the job; the version checks; the open request cancelled by an edit
// (Q-K14); the cleared revision naming its request; and the audit rows. The SQL, its CHECKs and
// triggers are in test/db/catalog-attribute-relaxation.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-02T10:00:00Z');
const FIRST = '01990000-0000-7000-8000-0000000000a1';
const SECOND = '01990000-0000-7000-8000-0000000000b1';

describe.each(['AU', 'ZZ'] as const)('material relaxation in market %s', (code) => {
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
  let allow: boolean;
  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const check: AuthorisationCheck = {
    check: (context, declaration) =>
      Promise.resolve(
        (declaration.rule.kind === 'system' && context.actor.kind === 'system') ||
          (allow &&
            declaration.rule.kind === 'permissions' &&
            declaration.rule.allOf.includes(CATALOG_ATTRIBUTE_EDIT.key))
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

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps = {
      unitOfWork,
      attributeStore: store,
      relaxations,
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
      request: new AttributeRelaxationRequestCreate(gate, deps),
      confirm: new AttributeRelaxationConfirm(gate, deps),
      cancel: new AttributeRelaxationCancel(gate, deps),
      list: new AttributeRelaxationListOpen(gate, deps),
      expire: new ExpireRelaxationRequests(gate, deps),
    };
  };

  beforeEach(() => {
    store = new MemoryAttributeDefinitionStore();
    relaxations = new MemoryAttributeRelaxationStore();
    audits = [];
    allow = true;
    clock.set(T0);
    ids = new SequenceIdGenerator(clock);
  });

  /** A published `material` select attribute, at version 2. */
  async function publishedMaterial(material = true) {
    const uc = build();
    const created = await uc.create.execute(admin(FIRST), {
      dataType: 'select',
      names: { [english]: 'Allergens' },
      material,
      options: [{ code: 'nuts', labels: { [english]: 'Nuts' } }],
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const published = await uc.publish.execute(admin(FIRST), {
      attributeId: created.value.attribute.id,
      version: created.value.attribute.version,
    });
    if (!published.ok) throw new Error(`publish failed: ${published.error.code}`);
    return published.value.attribute;
  }

  async function opened() {
    const attribute = await publishedMaterial();
    const answer = await build().request.execute(admin(FIRST), {
      attributeId: attribute.id,
      version: attribute.version,
      kind: 'clear-material',
    });
    if (!answer.ok) throw new Error(`request failed: ${answer.error.code}`);
    audits = [];
    return { attribute, request: answer.value.request };
  }

  describe('request', () => {
    it('opens a 72-hour request on a published material attribute, with one audit row', async () => {
      const attribute = await publishedMaterial();
      audits = [];
      const answer = await build().request.execute(admin(FIRST), {
        attributeId: attribute.id,
        version: attribute.version,
        kind: 'clear-material',
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.request).toMatchObject({
        attributeId: attribute.id,
        kind: 'clear-material',
        status: 'open',
        version: 1,
        expiresAt: '2026-11-05T10:00:00Z',
      });
      expect(store.rows.get(attribute.id)!.state.material).toBe(true);
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-relaxation.requested']);
    });

    it('refuses a draft, an attribute that is not material, a stale version and an unknown kind', async () => {
      const plain = await publishedMaterial(false);
      const uc = build();
      expect(
        await uc.request.execute(admin(FIRST), {
          attributeId: plain.id,
          version: plain.version,
          kind: 'clear-material',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.not-material' } });
      const material = await publishedMaterial();
      expect(
        await uc.request.execute(admin(FIRST), {
          attributeId: material.id,
          version: material.version - 1,
          kind: 'clear-material',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute.stale' } });
      expect(
        await uc.request.execute(admin(FIRST), {
          attributeId: material.id,
          version: material.version,
          kind: 'archive',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const draft = await uc.create.execute(admin(FIRST), {
        dataType: 'text',
        names: { [english]: 'Origin' },
        material: true,
      });
      if (!draft.ok) throw new Error('create failed');
      expect(
        await uc.request.execute(admin(FIRST), {
          attributeId: draft.value.attribute.id,
          version: draft.value.attribute.version,
          kind: 'clear-material',
        }),
      ).toMatchObject({ ok: false, error: { code: 'attribute-definition.not-material' } });
    });

    it('keeps one open request per attribute, and replaces one whose time ran out', async () => {
      const { attribute, request } = await opened();
      const uc = build();
      const again = {
        attributeId: attribute.id,
        version: attribute.version,
        kind: 'clear-material',
      };
      expect(await uc.request.execute(admin(SECOND), again)).toMatchObject({
        ok: false,
        error: { code: 'relaxation.already-open' },
      });
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      const answer = await uc.request.execute(admin(SECOND), again);
      expect(answer.ok).toBe(true);
      expect(relaxations.rows.get(request.id)!.state.status).toBe('expired');
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.attribute-relaxation.expired',
        'catalog.attribute-relaxation.requested',
      ]);
    });

    it('goes on when the lapsed request was closed meanwhile by the job (Sajad 2)', async () => {
      const { attribute, request } = await opened();
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      // The job wins the race: the row is expired by then, so this unit's move finds it moved.
      jest.spyOn(relaxations, 'saveMove').mockImplementationOnce((_market, lapsed) => {
        relaxations.rows.set(request.id, lapsed);
        return Promise.reject(new StaleAggregateError('attribute-relaxation-request', request.id));
      });
      const answer = await build().request.execute(admin(SECOND), {
        attributeId: attribute.id,
        version: attribute.version,
        kind: 'clear-material',
      });
      expect(answer).toMatchObject({ ok: true, value: { request: { status: 'open' } } });
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-relaxation.requested']);
    });

    it('is refused without the key and in an acting-as session', async () => {
      const attribute = await publishedMaterial();
      const input = {
        attributeId: attribute.id,
        version: attribute.version,
        kind: 'clear-material',
      };
      expect(await build().request.execute(actingAs(), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      allow = false;
      expect(await build().request.execute(admin(FIRST), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(relaxations.rows.size).toBe(0);
    });
  });

  describe('confirm', () => {
    it('lets a second admin clear material at once; the revision names the request; both ids are audited', async () => {
      const { attribute, request } = await opened();
      const answer = await build().confirm.execute(admin(SECOND), {
        requestId: request.id,
        version: request.version,
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.value.request).toMatchObject({ status: 'confirmed', version: 2 });
      const stored = store.rows.get(attribute.id)!.state;
      expect(stored).toMatchObject({ material: false, status: 'active', version: 3 });
      expect(store.authors.at(-1)).toEqual({
        revisionId: stored.revisionId,
        author: SECOND,
        relaxationRequestId: request.id,
      });
      expect(relaxations.rows.get(request.id)!.state.confirmedByAccountId).toBe(SECOND);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'catalog.attribute-definition.revised',
        targetId: attribute.id,
      });
      expect(JSON.stringify(audits[0])).toContain(FIRST);
      expect(JSON.stringify(audits[0])).toContain(request.id);
    });

    it('refuses the requester, a closed request and a stale version', async () => {
      const { request } = await opened();
      const uc = build();
      expect(
        await uc.confirm.execute(admin(FIRST), { requestId: request.id, version: request.version }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.same-admin' } });
      expect(
        await uc.confirm.execute(admin(SECOND), { requestId: request.id, version: 9 }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.stale' } });
      await uc.cancel.execute(admin(FIRST), { requestId: request.id, version: request.version });
      expect(
        await uc.confirm.execute(admin(SECOND), { requestId: request.id, version: 2 }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.closed' } });
      expect(
        await uc.confirm.execute(admin(SECOND), {
          requestId: '01990000-0000-7000-8000-00000000dead',
          version: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.not-found' } });
    });

    it('refuses after 72 hours by its own clock, before the job has run', async () => {
      const { attribute, request } = await opened();
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      expect(
        await build().confirm.execute(admin(SECOND), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.expired' } });
      expect(store.rows.get(attribute.id)!.state.material).toBe(true);
    });

    it('refuses after the job expired it, with expired (Sajad 1)', async () => {
      const { request } = await opened();
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      await build().expire.execute(testCallContext(market, 'system'), {});
      expect(
        await build().confirm.execute(admin(SECOND), { requestId: request.id, version: 2 }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.expired' } });
    });

    it('refuses when the attribute changed since the request', async () => {
      const { attribute, request } = await opened();
      const stored = relaxations.rows.get(request.id)!;
      relaxations.rows.set(
        request.id,
        AttributeRelaxationRequest.rehydrate({
          ...stored.state,
          definitionVersion: stored.state.definitionVersion - 1,
        }),
      );
      expect(
        await build().confirm.execute(admin(SECOND), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.attribute-changed' } });
      expect(store.rows.get(attribute.id)!.state.material).toBe(true);
    });

    it('refuses in an acting-as session', async () => {
      const { request } = await opened();
      expect(
        await build().confirm.execute(actingAs(), {
          requestId: request.id,
          version: request.version,
        }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('an edit while a request is open (Q-K14)', () => {
    it('cancels the request in the same unit, so it can never be confirmed', async () => {
      const { attribute, request } = await opened();
      const uc = build();
      const edited = await uc.edit.execute(admin(SECOND), {
        attributeId: attribute.id,
        version: attribute.version,
        names: { [english]: 'Allergens list' },
        material: true,
        isVariantOption: false,
        options: [{ code: 'nuts', labels: { [english]: 'Nuts' } }],
      });
      expect(edited.ok).toBe(true);
      expect(relaxations.rows.get(request.id)!.state).toMatchObject({
        status: 'cancelled',
        cancelReason: 'definition-changed',
        version: 2,
      });
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.attribute-definition.revised',
        'catalog.attribute-relaxation.cancelled',
      ]);
      // Hassan L1: the cancel row names the requester, not only the editor.
      expect(JSON.stringify(audits[1])).toContain(FIRST);
      expect(
        await uc.confirm.execute(admin(SECOND), { requestId: request.id, version: 2 }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.closed' } });
      expect(store.rows.get(attribute.id)!.state.material).toBe(true);
    });

    it('goes on when the request was closed meanwhile by its requester (Sajad 3)', async () => {
      const { attribute, request } = await opened();
      jest
        .spyOn(relaxations, 'saveMove')
        .mockRejectedValueOnce(new StaleAggregateError('attribute-relaxation-request', request.id));
      const edited = await build().edit.execute(admin(SECOND), {
        attributeId: attribute.id,
        version: attribute.version,
        names: { [english]: 'Allergens list' },
        material: true,
        isVariantOption: false,
        options: [{ code: 'nuts', labels: { [english]: 'Nuts' } }],
      });
      expect(edited.ok).toBe(true);
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.revised']);
    });

    it('still refuses clearing material by an edit of a published attribute', async () => {
      const attribute = await publishedMaterial();
      expect(
        await build().edit.execute(admin(FIRST), {
          attributeId: attribute.id,
          version: attribute.version,
          names: { [english]: 'Allergens' },
          material: false,
          isVariantOption: false,
          options: [{ code: 'nuts', labels: { [english]: 'Nuts' } }],
        }),
      ).toMatchObject({
        ok: false,
        error: { code: 'attribute-definition.material-relaxation-required' },
      });
    });
  });

  describe('cancel', () => {
    it('lets only the requester cancel', async () => {
      const { request } = await opened();
      const uc = build();
      expect(
        await uc.cancel.execute(admin(SECOND), { requestId: request.id, version: request.version }),
      ).toMatchObject({ ok: false, error: { code: 'relaxation.not-requester' } });
      const answer = await uc.cancel.execute(admin(FIRST), {
        requestId: request.id,
        version: request.version,
      });
      expect(answer).toMatchObject({ ok: true, value: { request: { status: 'cancelled' } } });
      expect(relaxations.rows.get(request.id)!.state.cancelReason).toBe('requester');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-relaxation.cancelled']);
    });

    it('is refused once its time ran out, and in an acting-as session', async () => {
      const { request } = await opened();
      const input = { requestId: request.id, version: request.version };
      expect(await build().cancel.execute(actingAs(), input)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      expect(await build().cancel.execute(admin(FIRST), input)).toMatchObject({
        ok: false,
        error: { code: 'relaxation.expired' },
      });
      expect(relaxations.rows.get(request.id)!.state.status).toBe('open');
    });
  });

  describe('list open ("Waiting for you")', () => {
    it('lists open requests in time, oldest first, with what the reader may do', async () => {
      const { attribute, request } = await opened();
      const answer = await build().list.execute(admin(SECOND), {});
      expect(answer).toEqual(
        ok({
          requests: [
            {
              id: request.id,
              version: 1,
              kind: 'clear-material',
              attribute: {
                id: attribute.id,
                code: 'allergens',
                names: { [english]: 'Allergens' },
                version: attribute.version,
              },
              mine: false,
              requestedByAccountId: FIRST,
              requestedAt: '2026-11-02T10:00:00Z',
              expiresAt: '2026-11-05T10:00:00Z',
              allowedActions: {
                confirm: { allowed: true },
                cancel: { allowed: false, reason: 'relaxation.not-requester' },
              },
            },
          ],
        }),
      );
      const own = await build().list.execute(admin(FIRST), {});
      expect(own.ok && own.value.requests[0]).toMatchObject({
        mine: true,
        allowedActions: {
          confirm: { allowed: false, reason: 'relaxation.same-admin' },
          cancel: { allowed: true },
        },
      });
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      expect(await build().list.execute(admin(SECOND), {})).toEqual(ok({ requests: [] }));
      expect(await build().list.execute(actingAs(), {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('expiry job', () => {
    it('expires the requests whose time ran out, once, with an audit row each', async () => {
      const { request } = await opened();
      const system = testCallContext(market, 'system');
      expect(await build().expire.execute(system, {})).toEqual(ok({ expired: 0 }));
      clock.advance(Temporal.Duration.from({ hours: 72 }));
      expect(await build().expire.execute(system, {})).toEqual(ok({ expired: 1 }));
      expect(relaxations.rows.get(request.id)!.state.status).toBe('expired');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-relaxation.expired']);
      expect(await build().expire.execute(system, {})).toEqual(ok({ expired: 0 }));
    });
  });
});
