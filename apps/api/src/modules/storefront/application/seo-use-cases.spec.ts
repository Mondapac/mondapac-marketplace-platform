import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
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
import { RecordingOutbox } from '../../../../test/support/catalog-tag-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz/authorisation-check';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { ConsumedStepUp, StepUpProofConsumer, StepUpRefusal } from '../../../platform/authz';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { STOREFRONT_SEO_PROTECTED_STEP_UP } from '../contracts/step-up';
import { StorefrontSeoSettingsChanged } from '../domain/audit';
import { StorefrontSeoIndexingChangedEvent } from '../domain/events';
import { DEFAULT_SEO_SETTINGS, type SeoSettings } from '../domain/seo-settings';
import type { SeoEnvironment } from './ports/seo-environment';
import type { SeoSettingsRecord, SeoSettingsRepository } from './ports/seo-settings.repository';
import { seoAggregateId } from './seo-flow';
import type { SeoDependencies } from './storefront-dependencies';
import { CheckStorefrontSeoManage } from './use-cases/check-seo-manage.use-case';
import { RestoreStorefrontSeoSettings } from './use-cases/restore-seo-settings.use-case';
import { SetStorefrontProtectedSeoSettings } from './use-cases/set-protected-seo-settings.use-case';
import { SetStorefrontSeoSettings } from './use-cases/set-seo-settings.use-case';
import { ViewPublicStorefrontSeo } from './use-cases/view-public-seo.use-case';
import { ViewStorefrontSeoSettings } from './use-cases/view-seo-settings.use-case';
import { ViewStorefrontSeoSettingsHistory } from './use-cases/view-seo-settings-history.use-case';

// The SEO settings use cases in memory on both Market fixtures: the view, edit and manage matrix
// through the real gate, defaults at version 0, a save as the next version with an audit row,
// the conflict, the no-op, the protected part (second factor, acting-as), restore, the indexing
// event, the public subset, and that a change in one Market never shows in the other.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-11T05:00:00Z');
const VERIFIED_AT = Temporal.Instant.from('2026-11-11T04:58:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const SESSION = id<'Session'>(0x61);
const VIEW = 'storefront.seo.view';
const EDIT = 'storefront.seo.edit';
const MANAGE = 'storefront.seo.manage';
const IMAGE = { ref: 'brand-card', alt: 'The Mondapac logo' };

class MemorySeoSettings implements SeoSettingsRepository {
  readonly rows: (SeoSettingsRecord & { market: string; changedBy: string })[] = [];
  taken = false;
  latest(market: MarketContext) {
    return Promise.resolve(
      [...this.rows].reverse().find((r) => r.market === market.marketId) ?? null,
    );
  }
  find(market: MarketContext, version: number) {
    return Promise.resolve(
      this.rows.find((r) => r.market === market.marketId && r.version === version) ?? null,
    );
  }
  append(market: MarketContext, record: SeoSettingsRecord & { changedBy: Id<'Account'> }) {
    if (this.taken) return Promise.resolve(false);
    this.rows.push({ ...record, market: market.marketId });
    return Promise.resolve(true);
  }
}

class RecordingStepUp implements StepUpProofConsumer {
  readonly asked: string[] = [];
  answer: ReturnType<typeof err<StepUpRefusal>> | null = null;
  consume(context: CallContext, actionKey: string) {
    this.asked.push(actionKey);
    if (this.answer !== null) return Promise.resolve(this.answer);
    const sessionId = (context.actor as { readonly sessionId: Id<'Session'> }).sessionId;
    return Promise.resolve(ok<ConsumedStepUp>({ sessionId, verifiedAt: VERIFIED_AT }));
  }
}

describe.each(TEST_MARKET_IDS)('SEO settings use cases in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  let held: Set<string>;
  let store: MemorySeoSettings;
  let audit: InMemoryAuditTrail;
  let outbox: RecordingOutbox;
  let stepUp: RecordingStepUp;
  let units: FakeUnitOfWork;
  let env: { ceiling: 'on' | 'off'; sampleData: boolean };
  let deps: SeoDependencies;
  const actors = new FakeChangeActors();

  // The gate asks this port: a key is held when the test gave it to the caller.
  const check: AuthorisationCheck = {
    check: (_context, declaration) => {
      const keys = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
      return Promise.resolve(
        keys.every((key) => held.has(key))
          ? { allowed: true as const }
          : { allowed: false as const, denial: { code: 'access.denied' as const } },
      );
    },
  };
  const gate = createUseCaseGate(markets, check);

  const admin = (target: MarketContext = market, extra: object = {}): CallContext => {
    const context = testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: SESSION,
        sellerId: null,
      }),
      'seo-admin-abcd',
    );
    return Object.keys(extra).length === 0
      ? context
      : { ...context, actor: { ...context.actor, ...extra } };
  };
  const actingAs = (): CallContext => admin(market, { actingAs: { sellerId: id<'Seller'>(0x51) } });
  const anonymous = (target: MarketContext = market) => testCallContext(target, 'anonymous');

  beforeEach(() => {
    held = new Set([VIEW, EDIT, MANAGE]);
    const clock = new FixedClock(T0);
    store = new MemorySeoSettings();
    audit = new InMemoryAuditTrail(clock);
    outbox = new RecordingOutbox();
    stepUp = new RecordingStepUp();
    units = new FakeUnitOfWork();
    env = { ceiling: 'off', sampleData: false };
    const environment: SeoEnvironment = {
      ceiling: () => env.ceiling,
      sampleDataLock: () => env.sampleData,
    };
    deps = {
      unitOfWork: units,
      audit,
      clock,
      seoSettings: store,
      seoEnvironment: environment,
      trail: changeTrailOf(units, audit, actors),
      outbox,
      stepUp,
      seoManageProbe: new CheckStorefrontSeoManage(gate),
    };
    actors.labels.set(ADMIN, { kind: 'member', displayName: 'Sara K.' });
  });

  const view = (context = admin()) =>
    new ViewStorefrontSeoSettings(gate, deps).execute(context, {});
  const history = (context = admin(), input: object = {}) =>
    new ViewStorefrontSeoSettingsHistory(gate, deps).execute(context, input);
  const publicRead = (context = anonymous()) =>
    new ViewPublicStorefrontSeo(gate, deps).execute(context, {});
  const setEdit = (settings: unknown, expectedVersion: unknown = 0, context = admin()) =>
    new SetStorefrontSeoSettings(gate, deps).execute(context, { settings, expectedVersion });
  const setProtected = (settings: unknown, expectedVersion: unknown = 0, context = admin()) =>
    new SetStorefrontProtectedSeoSettings(gate, deps).execute(context, {
      settings,
      expectedVersion,
    });
  const restore = (version: unknown, expectedVersion: unknown, context = admin()) =>
    new RestoreStorefrontSeoSettings(gate, deps).execute(context, { version, expectedVersion });

  const editPart = (patch: Partial<SeoSettings> = {}) => ({
    siteName: DEFAULT_SEO_SETTINGS.siteName,
    titleTemplate: DEFAULT_SEO_SETTINGS.titleTemplate,
    defaultDescription: DEFAULT_SEO_SETTINGS.defaultDescription,
    defaultShareImage: DEFAULT_SEO_SETTINGS.defaultShareImage,
    sellerPages: DEFAULT_SEO_SETTINGS.sellerPages,
    sameAs: DEFAULT_SEO_SETTINGS.sameAs,
    pageTemplates: DEFAULT_SEO_SETTINGS.pageTemplates,
    ...patch,
  });
  const managePart = (patch: Partial<SeoSettings> = {}) => ({
    indexing: DEFAULT_SEO_SETTINGS.indexing,
    logo: DEFAULT_SEO_SETTINGS.logo,
    tradingName: DEFAULT_SEO_SETTINGS.tradingName,
    legalName: DEFAULT_SEO_SETTINGS.legalName,
    abn: DEFAULT_SEO_SETTINGS.abn,
    postalAddress: DEFAULT_SEO_SETTINGS.postalAddress,
    contactEmail: DEFAULT_SEO_SETTINGS.contactEmail,
    contactPhone: DEFAULT_SEO_SETTINGS.contactPhone,
    googleVerification: DEFAULT_SEO_SETTINGS.googleVerification,
    bingVerification: DEFAULT_SEO_SETTINGS.bingVerification,
    analyticsId: DEFAULT_SEO_SETTINGS.analyticsId,
    ...patch,
  });

  describe('the view, edit and manage matrix (the real gate)', () => {
    it('lets a viewer read and refuses every change', async () => {
      held = new Set([VIEW]);
      expect((await view()).ok).toBe(true);
      expect((await history()).ok).toBe(true);
      expect(await setEdit(editPart())).toEqual(err({ code: 'access.denied' }));
      expect(await setProtected(managePart())).toEqual(err({ code: 'access.denied' }));
      expect(await restore(0, 0)).toEqual(err({ code: 'access.denied' }));
      expect(store.rows).toEqual([]);
    });

    it('lets an editor change texts but not the protected part', async () => {
      held = new Set([VIEW, EDIT]);
      expect((await setEdit(editPart({ siteName: 'Mondapac AU' }))).ok).toBe(true);
      expect(await setProtected(managePart({ indexing: 'on' }), 1)).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(stepUp.asked).toEqual([]);
    });

    it('lets a manager change the protected part but not the texts', async () => {
      held = new Set([VIEW, MANAGE]);
      expect(await setEdit(editPart({ siteName: 'Mondapac AU' }))).toEqual(
        err({ code: 'access.denied' }),
      );
      expect((await setProtected(managePart({ tradingName: 'Mondapac' }))).ok).toBe(true);
    });

    it('refuses everything to a caller with no key, a seller and an anonymous caller', async () => {
      held = new Set();
      expect(await view()).toEqual(err({ code: 'access.denied' }));
      expect(await history()).toEqual(err({ code: 'access.denied' }));
      held = new Set([VIEW, EDIT, MANAGE]);
      const seller = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: id<'Account'>(0xa1),
          sessionId: SESSION,
          sellerId: id<'Seller'>(0x51),
        }),
        'seo-seller-abcd',
      );
      expect(await view(seller)).toEqual(err({ code: 'access.denied' }));
      expect(await setEdit(editPart(), 0, seller)).toEqual(err({ code: 'access.denied' }));
      expect(await setProtected(managePart(), 0, seller)).toEqual(err({ code: 'access.denied' }));
      const anon = await view(anonymous());
      expect(anon.ok).toBe(false);
    });

    it('lets a restore that changes only edit fields run on the edit key alone', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      await setEdit(editPart({ siteName: 'Second' }), 1);
      held = new Set([VIEW, EDIT]);
      const restored = await restore(1, 2);
      expect(restored.ok && restored.value.settings.siteName).toBe('First');
      expect(stepUp.asked).toEqual([]);
    });

    it('needs the manage key and a second factor to restore a protected field', async () => {
      await setProtected(managePart({ tradingName: 'Mondapac Pty Ltd' }));
      await setProtected(managePart({ tradingName: 'Other' }), 1);
      stepUp.asked.length = 0;
      held = new Set([VIEW, EDIT]);
      expect(await restore(1, 2)).toEqual(err({ code: 'access.denied' }));
      expect(stepUp.asked).toEqual([]);
      held = new Set([VIEW, EDIT, MANAGE]);
      const restored = await restore(1, 2);
      expect(restored.ok && restored.value.settings.tradingName).toBe('Mondapac Pty Ltd');
      expect(stepUp.asked).toEqual([STOREFRONT_SEO_PROTECTED_STEP_UP]);
      expect(store.rows.at(-1)?.version).toBe(3);
    });
  });

  describe('reading', () => {
    it('reads the code defaults as version 0, indexing off, in a read-only unit', async () => {
      const read = await view();
      expect(read).toEqual(
        ok({
          version: 0,
          settings: DEFAULT_SEO_SETTINGS,
          sampleDataLock: false,
          envCeiling: 'off',
          lastChanged: null,
        }),
      );
      expect(units.units.some((unit) => unit.options?.readOnly === true)).toBe(true);
    });

    it('says what bounds the indexing switch', async () => {
      env = { ceiling: 'on', sampleData: true };
      const read = await view();
      expect(read.ok && [read.value.envCeiling, read.value.sampleDataLock]).toEqual(['on', true]);
    });

    it('names who changed the settings last and when', async () => {
      await setEdit(editPart({ siteName: 'Mondapac AU' }));
      const read = await view();
      expect(read.ok && read.value.lastChanged).toEqual({
        at: T0,
        byDisplayName: 'Sara K.',
        byKind: 'member',
      });
    });
  });

  describe('an edit save', () => {
    it('saves the next version, leaves the protected part alone and writes one audit row', async () => {
      const saved = await setEdit(
        editPart({
          siteName: 'Mondapac AU',
          sameAs: ['https://x.com/mondapac'],
          defaultShareImage: IMAGE,
        }),
      );
      expect(saved.ok && saved.value.version).toBe(1);
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({
        version: 1,
        market: code,
        changedAt: T0,
        changedBy: ADMIN,
      });
      expect(store.rows[0]!.settings).toEqual({
        ...DEFAULT_SEO_SETTINGS,
        siteName: 'Mondapac AU',
        sameAs: ['https://x.com/mondapac'],
        defaultShareImage: IMAGE,
      });
      expect(audit.entries).toEqual([
        StorefrontSeoSettingsChanged.entry('seo-settings', {
          before: { version: 0, indexing: 'off' },
          after: {
            version: 1,
            indexing: 'off',
            changed: ['site-name', 'default-share-image', 'same-as'],
            restoredFrom: null,
            stepUpSessionId: null,
            stepUpVerifiedAt: null,
          },
        }),
      ]);
      expect(outbox.appended).toEqual([]);
      expect(stepUp.asked).toEqual([]);
    });

    it('keeps the fields of the other part when the stored version holds values for them', async () => {
      await setProtected(managePart({ tradingName: 'Mondapac' }));
      await setEdit(editPart({ siteName: 'Mondapac AU' }), 1);
      expect(store.rows.at(-1)!.settings).toMatchObject({
        siteName: 'Mondapac AU',
        tradingName: 'Mondapac',
      });
    });

    it('makes the same settings again a no-op: no version, no audit row, no event', async () => {
      await setEdit(editPart({ siteName: 'Mondapac AU' }));
      audit.entries.length = 0;
      const again = await setEdit(editPart({ siteName: 'Mondapac AU' }), 1);
      expect(again.ok && again.value.version).toBe(1);
      expect(store.rows).toHaveLength(1);
      expect(audit.entries).toEqual([]);
    });

    it('never lets the edit route change a protected field, even when a stored value normalises differently', async () => {
      store.rows.push({
        market: market.marketId,
        version: 1,
        settings: { ...DEFAULT_SEO_SETTINGS, contactEmail: 'Sales@Example.com' },
        changedAt: T0,
        changedBy: ADMIN,
      });
      held = new Set([VIEW, EDIT]);
      const result = await setEdit(editPart({ siteName: 'Another' }), 1);
      expect(result).toEqual(err({ code: 'access.denied' }));
      expect(stepUp.asked).toEqual([]);
      expect(store.rows).toHaveLength(1);
    });

    it('answers a range error, not a database error, for a version beyond the column', async () => {
      const result = await setEdit(editPart(), 2 ** 31);
      expect(result).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'expectedVersion', code: 'range' }] }),
      );
    });

    it('refuses a stale version with the winning save named, and writes nothing', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      audit.entries.length = 0;
      const stale = await setEdit(editPart({ siteName: 'Second' }), 0);
      expect(stale).toEqual(
        err({
          code: 'storefront.conflict',
          lastChanged: { at: T0, byDisplayName: 'Sara K.', byKind: 'member' },
        }),
      );
      expect(store.rows).toHaveLength(1);
      expect(audit.entries).toEqual([]);
    });

    it('answers a conflict when another save takes the version first', async () => {
      store.taken = true;
      const lost = await setEdit(editPart({ siteName: 'Second' }));
      expect(lost.ok).toBe(false);
      expect(!lost.ok && lost.error.code).toBe('storefront.conflict');
      expect(audit.entries).toEqual([]);
    });

    it.each([
      [{ siteName: '' }, 'settings.siteName', 'range'],
      [{ titleTemplate: 'no placeholder' }, 'settings.titleTemplate', 'placeholder'],
      [{ defaultDescription: 'short' }, 'settings.defaultDescription', 'range'],
      [{ sameAs: ['http://x.com'] }, 'settings.sameAs[0]', 'format'],
      [{ sellerPages: 'all' }, 'settings.sellerPages', 'type'],
    ])('answers validation.failed for %j', async (patch, path, codeOf) => {
      const refused = await setEdit(editPart(patch as never));
      expect(refused).toEqual(err({ code: 'validation.failed', fields: [{ path, code: codeOf }] }));
      expect(store.rows).toEqual([]);
    });

    it('refuses a body with a field of the other part, a missing field and a bad version', async () => {
      const wrong = await setEdit({ ...editPart(), indexing: 'on' });
      expect(wrong).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: 'settings.indexing', code: 'unknown-field' }],
        }),
      );
      const missing: Record<string, unknown> = { ...editPart() };
      delete missing.sameAs;
      expect(await setEdit(missing)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'settings.sameAs', code: 'required' }] }),
      );
      expect(await setEdit(editPart(), -1)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'expectedVersion', code: 'range' }] }),
      );
      expect(await setEdit(editPart(), '0')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'expectedVersion', code: 'range' }] }),
      );
      expect(await setEdit([], 0)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'settings', code: 'type' }] }),
      );
      expect(store.rows).toEqual([]);
    });
  });

  describe('the protected save', () => {
    it('spends one second-factor proof and names it in the audit row', async () => {
      const saved = await setProtected(
        managePart({ tradingName: 'Mondapac', abn: '51 824 753 556', analyticsId: 'G-ABCDEF1' }),
      );
      expect(saved.ok && saved.value.version).toBe(1);
      expect(stepUp.asked).toEqual([STOREFRONT_SEO_PROTECTED_STEP_UP]);
      expect(store.rows[0]!.settings).toMatchObject({
        tradingName: 'Mondapac',
        abn: '51824753556',
        analyticsId: 'G-ABCDEF1',
      });
      expect(audit.entries).toEqual([
        StorefrontSeoSettingsChanged.entry('seo-settings', {
          before: { version: 0, indexing: 'off' },
          after: {
            version: 1,
            indexing: 'off',
            changed: ['trading-name', 'abn', 'analytics-id'],
            restoredFrom: null,
            stepUpSessionId: SESSION,
            stepUpVerifiedAt: VERIFIED_AT,
          },
        }),
      ]);
    });

    it('is refused in an acting-as session before anything is spent', async () => {
      expect(await setProtected(managePart({ tradingName: 'Mondapac' }), 0, actingAs())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(stepUp.asked).toEqual([]);
      expect(store.rows).toEqual([]);
    });

    it('commits nothing and writes no audit row when the second factor is missing', async () => {
      stepUp.answer = err({
        code: 'second-factor.required',
        actionKey: STOREFRONT_SEO_PROTECTED_STEP_UP,
      });
      expect(await setProtected(managePart({ tradingName: 'Mondapac' }))).toEqual(
        err({ code: 'second-factor.required', actionKey: STOREFRONT_SEO_PROTECTED_STEP_UP }),
      );
      stepUp.answer = err({
        code: 'second-factor.enrolment-required',
        actionKey: STOREFRONT_SEO_PROTECTED_STEP_UP,
      });
      expect(await setProtected(managePart({ tradingName: 'Mondapac' }))).toEqual(
        err({
          code: 'second-factor.enrolment-required',
          actionKey: STOREFRONT_SEO_PROTECTED_STEP_UP,
        }),
      );
      stepUp.answer = err({ code: 'access.unavailable' });
      expect(await setProtected(managePart({ tradingName: 'Mondapac' }))).toEqual(
        err({ code: 'access.unavailable' }),
      );
      expect(store.rows).toEqual([]);
      expect(audit.entries).toEqual([]);
    });

    it('keeps the proof on a stale save and on the same settings again (nothing is spent)', async () => {
      await setProtected(managePart({ tradingName: 'Mondapac' }));
      stepUp.asked.length = 0;
      expect((await setProtected(managePart({ tradingName: 'Other' }), 0)).ok).toBe(false);
      expect((await setProtected(managePart({ tradingName: 'Mondapac' }), 1)).ok).toBe(true);
      expect(stepUp.asked).toEqual([]);
    });

    it.each([
      [{ abn: '12345678901' }, 'settings.abn', 'format'],
      [{ googleVerification: 'short' }, 'settings.googleVerification', 'format'],
      [{ analyticsId: 'UA-1' }, 'settings.analyticsId', 'format'],
      [{ contactPhone: '0412' }, 'settings.contactPhone', 'format'],
      [{ tradingName: '<b>x</b>' }, 'settings.tradingName', 'format'],
    ])('answers validation.failed for %j and spends nothing', async (patch, path, codeOf) => {
      const refused = await setProtected(managePart(patch));
      expect(refused).toEqual(err({ code: 'validation.failed', fields: [{ path, code: codeOf }] }));
      expect(stepUp.asked).toEqual([]);
    });

    it('refuses a body with a field of the edit part', async () => {
      const wrong = await setProtected({ ...managePart(), siteName: 'x' });
      expect(wrong).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: 'settings.siteName', code: 'unknown-field' }],
        }),
      );
    });
  });

  describe('the indexing switch', () => {
    it('turns on with a version, an audit row and one event that carries the version only', async () => {
      const saved = await setProtected(managePart({ indexing: 'on' }));
      expect(saved.ok && saved.value.settings.indexing).toBe('on');
      expect(outbox.types).toEqual(['storefront.seo-indexing-changed.v1']);
      expect(outbox.appended).toEqual([
        StorefrontSeoIndexingChangedEvent.record({
          aggregateId: seoAggregateId(market),
          aggregateVersion: 1,
          occurredAt: T0,
          payload: { version: 1 },
        }),
      ]);
      expect(JSON.stringify(outbox.appended)).not.toContain(ADMIN);
    });

    it('writes an event for each move of the switch and none for other changes', async () => {
      await setProtected(managePart({ indexing: 'on' }));
      await setProtected(managePart({ indexing: 'on', tradingName: 'Mondapac' }), 1);
      await setProtected(managePart({ indexing: 'off', tradingName: 'Mondapac' }), 2);
      expect(outbox.appended.map((event) => event.aggregateVersion)).toEqual([1, 3]);
    });

    it('is locked while the storefront runs on sample data, and nothing is spent', async () => {
      env.sampleData = true;
      const refused = await setProtected(managePart({ indexing: 'on' }));
      expect(refused).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'indexing', code: 'locked' }] }),
      );
      expect(stepUp.asked).toEqual([]);
      expect(outbox.appended).toEqual([]);
      // Other protected fields are not locked, and indexing may still stay off.
      expect((await setProtected(managePart({ tradingName: 'Mondapac' }))).ok).toBe(true);
    });

    it('can be stored on under an env ceiling of off (the ceiling is applied when the site reads it)', async () => {
      env.ceiling = 'off';
      const saved = await setProtected(managePart({ indexing: 'on' }));
      expect(saved.ok && [saved.value.settings.indexing, saved.value.envCeiling]).toEqual([
        'on',
        'off',
      ]);
    });
  });

  describe('history and restore', () => {
    it('lists the versions newest first with who, when, the changed field names and the version', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      await setProtected(managePart({ tradingName: 'Mondapac' }), 1);
      const page = await history();
      expect(page).toEqual(
        ok({
          items: [
            {
              id: expect.any(String) as string,
              at: T0,
              byDisplayName: 'Sara K.',
              byKind: 'member',
              fields: ['tradingName'],
              version: 2,
            },
            {
              id: expect.any(String) as string,
              at: T0,
              byDisplayName: 'Sara K.',
              byKind: 'member',
              fields: ['siteName'],
              version: 1,
            },
          ],
          next: null,
        }),
      );
      expect(JSON.stringify(page)).not.toContain('Mondapac');
    });

    it('pages the history and refuses a bad limit', async () => {
      await setEdit(editPart({ siteName: 'One' }));
      await setEdit(editPart({ siteName: 'Two' }), 1);
      const first = await history(admin(), { limit: 1 });
      expect(first.ok && first.value.items.map((i) => i.version)).toEqual([2]);
      expect(first.ok && first.value.next).not.toBeNull();
      expect((await history(admin(), { limit: 0 })).ok).toBe(false);
    });

    it('restores an older version as a new one and records where it came from', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      await setEdit(editPart({ siteName: 'Second' }), 1);
      audit.entries.length = 0;
      const restored = await restore(1, 2);
      expect(restored.ok && [restored.value.version, restored.value.settings.siteName]).toEqual([
        3,
        'First',
      ]);
      expect(store.rows.map((r) => r.version)).toEqual([1, 2, 3]);
      expect(audit.entries).toEqual([
        StorefrontSeoSettingsChanged.entry('seo-settings', {
          before: { version: 2, indexing: 'off' },
          after: {
            version: 3,
            indexing: 'off',
            changed: ['site-name'],
            restoredFrom: 1,
            stepUpSessionId: null,
            stepUpVerifiedAt: null,
          },
        }),
      ]);
    });

    it('restores version 0, the code defaults', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      const restored = await restore(0, 1);
      expect(restored.ok && restored.value.settings).toEqual(DEFAULT_SEO_SETTINGS);
    });

    it('changes nothing when the old version equals the current one', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      await setEdit(editPart({ siteName: 'Second' }), 1);
      await setEdit(editPart({ siteName: 'First' }), 2);
      audit.entries.length = 0;
      const same = await restore(1, 3);
      expect(same.ok && same.value.version).toBe(3);
      expect(store.rows).toHaveLength(3);
      expect(audit.entries).toEqual([]);
    });

    it('writes the indexing event when a restore moves the switch', async () => {
      await setProtected(managePart({ indexing: 'on' }));
      await setProtected(managePart({ indexing: 'off' }), 1);
      outbox.appended.length = 0;
      const restored = await restore(1, 2);
      expect(restored.ok && restored.value.settings.indexing).toBe('on');
      expect(outbox.appended.map((event) => event.aggregateVersion)).toEqual([3]);
    });

    it('refuses to restore a protected field in an acting-as session, before anything is spent', async () => {
      await setProtected(managePart({ tradingName: 'Mondapac' }));
      await setProtected(managePart({ tradingName: 'Other' }), 1);
      stepUp.asked.length = 0;
      expect(await restore(1, 2, actingAs())).toEqual(err({ code: 'access.denied' }));
      expect(stepUp.asked).toEqual([]);
    });

    it('answers not-found for a version that never existed, conflict for a stale one, and validates', async () => {
      await setEdit(editPart({ siteName: 'First' }));
      expect(await restore(9, 1)).toEqual(err({ code: 'storefront.seo-version-not-found' }));
      expect((await restore(0, 0)).ok).toBe(false);
      expect(await restore(-1, 1)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'version', code: 'range' }] }),
      );
      expect(await restore(1.5, 1)).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'version', code: 'range' }] }),
      );
    });

    it('restores into the same Market only: a version number of another Market is not found', async () => {
      await new SetStorefrontSeoSettings(gate, deps).execute(admin(other), {
        settings: editPart({ siteName: 'Other market' }),
        expectedVersion: 0,
      });
      expect(await restore(1, 0)).toEqual(err({ code: 'storefront.seo-version-not-found' }));
    });
  });

  describe('the public read', () => {
    it('answers the defaults with no session, indexing off', async () => {
      const read = await publicRead();
      expect(read.ok && read.value.indexing).toBe('off');
      expect(read.ok && read.value.siteName).toBe('Mondapac');
    });

    it('answers public fields only: no version, no editor, no focus keyword, no other Market', async () => {
      await setProtected(
        managePart({ tradingName: 'Mondapac', abn: '51824753556', analyticsId: 'G-ABCDEF1' }),
      );
      const read = await publicRead();
      expect(read.ok && read.value.organization.tradingName).toBe('Mondapac');
      expect(read.ok && read.value.analyticsId).toBe('G-ABCDEF1');
      const json = JSON.stringify(read);
      expect(json).not.toMatch(/version|changedBy|changedAt|focus|keyword/i);
      expect(json).not.toContain(ADMIN);
    });

    it('reads in a read-only unit and does not need a session', async () => {
      units.units.length = 0;
      await publicRead();
      expect(units.units.every((unit) => unit.options?.readOnly === true)).toBe(true);
      expect(held.size).toBe(3);
    });
  });

  it('keeps a change in one Market out of the other', async () => {
    await setEdit(editPart({ siteName: 'Here' }));
    await setProtected(managePart({ tradingName: 'Here Pty' }), 1);

    const here = await publicRead(anonymous(market));
    const there = await publicRead(anonymous(other));
    expect(here.ok && here.value.siteName).toBe('Here');
    expect(there.ok && there.value.siteName).toBe(DEFAULT_SEO_SETTINGS.siteName);
    expect(there.ok && there.value.organization.tradingName).toBeNull();

    const viewThere = await view(admin(other));
    expect(viewThere.ok && viewThere.value.version).toBe(0);
    const historyThere = await history(admin(other));
    expect(historyThere.ok && historyThere.value.items).toEqual([]);

    // The other Market starts from its own version 0 and gets its own version 1.
    const saved = await new SetStorefrontSeoSettings(gate, deps).execute(admin(other), {
      settings: editPart({ siteName: 'There' }),
      expectedVersion: 0,
    });
    expect(saved.ok && saved.value.version).toBe(1);
    const hereAfter = await publicRead(anonymous(market));
    expect(hereAfter.ok && hereAfter.value.siteName).toBe('Here');
  });
});
