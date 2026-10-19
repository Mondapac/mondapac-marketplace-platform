import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  DEFAULT_ASSISTANT_SETTINGS,
  inRollout,
  parseAssistantSettings,
  parseWelcomeText,
  rolloutBucket,
  type AssistantSettings,
  type ModelTier,
} from '../domain/assistant-settings';
import { AssistantSettingsChanged } from '../domain/audit';
import type { AssistantDependencies } from './assistant-dependencies';
import type { AssistantRuntime } from './ports/assistant-runtime';
import type {
  AssistantSettingsRecord,
  AssistantSettingsRepository,
} from './ports/assistant-settings.repository';
import { SetAssistantSettings } from './use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from './use-cases/view-assistant-settings.use-case';
import { ViewStorefrontAssistant } from './use-cases/view-storefront-assistant.use-case';

// The buyer assistant settings in memory on both Market fixtures: defaults (off), validation of
// every bound, an admin change with a version and an audit row, the conflict, and the safe subset
// the storefront reads. The API key is reported as set or not, never returned.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-19T21:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const VISITOR = 'visitor-key-0123456789';

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (entry.action !== AssistantSettingsChanged.action) throw new Error('audit: unknown action');
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class MemorySettings implements AssistantSettingsRepository {
  readonly rows: (AssistantSettingsRecord & { changedBy: string })[] = [];
  taken = false;
  latest() {
    return Promise.resolve(this.rows.at(-1) ?? null);
  }
  append(_m: MarketContext, record: AssistantSettingsRecord & { changedBy: Id<'Account'> }) {
    if (this.taken) return Promise.resolve(false);
    this.rows.push(record);
    return Promise.resolve(true);
  }
}

class FakeRuntime implements AssistantRuntime {
  key = true;
  models: Record<ModelTier, string | null> = { fast: 'model-fast', balanced: null };
  apiKeyConfigured() {
    return this.key;
  }
  modelOf(tier: ModelTier) {
    return this.models[tier];
  }
}

const on = (overrides: Partial<AssistantSettings> = {}): AssistantSettings => ({
  ...DEFAULT_ASSISTANT_SETTINGS,
  enabled: true,
  audience: 'all',
  ...overrides,
});

describe('parseAssistantSettings', () => {
  it('accepts the defaults', () => {
    expect(parseAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS })).toEqual(
      ok(DEFAULT_ASSISTANT_SETTINGS),
    );
  });

  it('ships the recommended options with the assistant off', () => {
    expect(DEFAULT_ASSISTANT_SETTINGS).toEqual({
      enabled: false,
      audience: 'internal',
      audiencePercent: null,
      scope: 'read-only',
      modelTier: 'fast',
      users: 'guests-and-customers',
      guestMessageLimit: 20,
      customerMessageLimit: 40,
      retention: '30-days',
      replyLanguage: 'buyer',
      dailySpendCapUsdCents: 1_000,
      monthlySpendCapUsdCents: 20_000,
      supportHandoff: 'email-link',
      welcomeText: null,
    });
  });

  it.each([
    ['guestMessageLimit', 4, 'range'],
    ['guestMessageLimit', 61, 'range'],
    ['guestMessageLimit', 20.5, 'type'],
    ['customerMessageLimit', 4, 'range'],
    ['customerMessageLimit', 121, 'range'],
    ['customerMessageLimit', '40', 'type'],
    ['dailySpendCapUsdCents', 99, 'range'],
    ['dailySpendCapUsdCents', 100_001, 'range'],
    ['monthlySpendCapUsdCents', 2_000_001, 'range'],
    ['enabled', 'true', 'type'],
    ['audience', 'everyone', 'type'],
    ['audiencePercent', 10, 'type'],
    ['modelTier', 'model-fast', 'type'],
    ['users', 'guests', 'type'],
    ['retention', '7-days', 'type'],
    ['replyLanguage', 'fa', 'type'],
    ['scope', 'cart-suggestions', 'unavailable'],
    ['supportHandoff', 'in-panel-form', 'unavailable'],
    ['welcomeText', 42, 'type'],
    ['welcomeText', undefined, 'type'],
  ] as const)('refuses %s = %j (%s)', (path, value, code) => {
    const result = parseAssistantSettings({ ...DEFAULT_ASSISTANT_SETTINGS, [path]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContainEqual({ path, code });
  });

  it('needs a percentage of 1 to 100 for a percentage rollout, and only then', () => {
    const percent = (audiencePercent: unknown) =>
      parseAssistantSettings({
        ...DEFAULT_ASSISTANT_SETTINGS,
        audience: 'percent',
        audiencePercent,
      });
    expect(percent(10).ok).toBe(true);
    expect(percent(100).ok).toBe(true);
    for (const bad of [0, 101]) {
      expect(percent(bad)).toEqual({
        ok: false,
        error: [{ path: 'audiencePercent', code: 'range' }],
      });
    }
    expect(percent(null)).toEqual({
      ok: false,
      error: [{ path: 'audiencePercent', code: 'type' }],
    });
  });

  it('refuses a daily cap above the monthly cap', () => {
    const result = parseAssistantSettings({
      ...DEFAULT_ASSISTANT_SETTINGS,
      dailySpendCapUsdCents: 5_000,
      monthlySpendCapUsdCents: 4_000,
    });
    expect(result).toEqual({
      ok: false,
      error: [{ path: 'dailySpendCapUsdCents', code: 'range' }],
    });
  });

  it('refuses a non-object', () => {
    for (const value of [null, [], 'x', 1]) {
      expect(parseAssistantSettings(value)).toEqual({
        ok: false,
        error: [{ path: '', code: 'type' }],
      });
    }
  });
});

describe('parseWelcomeText', () => {
  it('trims, keeps Persian with its zero-width non-joiner, and maps empty to the default', () => {
    expect(parseWelcomeText('  سلام! می‌توانم کمک کنم؟ ')).toEqual(ok('سلام! می‌توانم کمک کنم؟'));
    expect(parseWelcomeText('   ')).toEqual(ok(null));
    expect(parseWelcomeText(null)).toEqual(ok(null));
    expect(parseWelcomeText('x'.repeat(200))).toEqual(ok('x'.repeat(200)));
  });

  it.each([
    ['x'.repeat(201), 'range'],
    ['Hi\u0000there', 'format'],
    ['Hi\nthere', 'format'],
    ['Hi ‮ereht', 'format'],
    ['<b>Hi</b>', 'format'],
  ] as const)('refuses %j', (value, code) => {
    expect(parseWelcomeText(value)).toEqual({ ok: false, error: { path: 'welcomeText', code } });
  });
});

describe('the rollout', () => {
  it('spreads visitors into stable buckets', () => {
    expect(rolloutBucket('AU', VISITOR)).toBe(rolloutBucket('AU', VISITOR));
    const buckets = new Set(
      Array.from({ length: 500 }, (_, n) => rolloutBucket('AU', `visitor-${n}`)),
    );
    expect(buckets.size).toBeGreaterThan(90);
    for (const bucket of buckets) expect(bucket).toBeGreaterThanOrEqual(0);
    for (const bucket of buckets) expect(bucket).toBeLessThan(100);
  });

  it('shows nothing when off or internal, everything when all, a share when percent', () => {
    expect(inRollout(DEFAULT_ASSISTANT_SETTINGS, 'AU', VISITOR)).toBe(false);
    expect(inRollout(on({ enabled: false }), 'AU', VISITOR)).toBe(false);
    expect(inRollout(on({ audience: 'internal' }), 'AU', VISITOR)).toBe(false);
    expect(inRollout(on(), 'AU', null)).toBe(true);
    expect(inRollout(on({ audience: 'percent', audiencePercent: 100 }), 'AU', VISITOR)).toBe(true);
    expect(inRollout(on({ audience: 'percent', audiencePercent: 100 }), 'AU', null)).toBe(false);
    const half = on({ audience: 'percent', audiencePercent: 50 });
    const shown = Array.from({ length: 1000 }, (_, n) => inRollout(half, 'AU', `v-${n}`)).filter(
      Boolean,
    ).length;
    expect(shown).toBeGreaterThan(400);
    expect(shown).toBeLessThan(600);
  });
});

describe.each(TEST_MARKET_IDS)('assistant settings use cases in market %s', (code) => {
  let deps: AssistantDependencies;
  let settings: MemorySettings;
  let audit: RecordingAudit;
  let runtime: FakeRuntime;
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `assistant-${population}-abcd`,
    );
  const admin = () => actor('admin');
  const seller = () => actor('seller');
  const anonymous = () => testCallContext(market, 'anonymous');

  beforeEach(() => {
    settings = new MemorySettings();
    audit = new RecordingAudit();
    runtime = new FakeRuntime();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      settings,
      runtime,
      audit,
      clock: new FixedClock(T0),
    };
  });

  const view = () => new ViewAssistantSettings(gate, deps).execute(admin(), {});
  const set = (next: unknown, expectedVersion: unknown = 0, context = admin()) =>
    new SetAssistantSettings(gate, deps).execute(context, { settings: next, expectedVersion });
  const storefront = (visitor: unknown = VISITOR) =>
    new ViewStorefrontAssistant(gate, deps).execute(anonymous(), { visitor });

  it('reads the defaults as version 0, with the key status and the model of each tier', async () => {
    const read = await view();
    expect(read).toEqual(
      ok({
        version: 0,
        settings: DEFAULT_ASSISTANT_SETTINGS,
        apiKey: 'set',
        models: [
          { tier: 'fast', modelId: 'model-fast' },
          { tier: 'balanced', modelId: null },
        ],
        unavailableOptions: { scope: ['cart-suggestions'], supportHandoff: ['in-panel-form'] },
      }),
    );
    runtime.key = false;
    const unset = await view();
    expect(unset.ok && unset.value.apiKey).toBe('not-set');
  });

  it('saves a change as the next version with an audit row of the versions and the switch', async () => {
    const saved = await set(on({ welcomeText: 'Hello' }));
    expect(saved.ok && saved.value.version).toBe(1);
    expect(settings.rows).toEqual([
      { version: 1, settings: on({ welcomeText: 'Hello' }), changedAt: T0, changedBy: ADMIN },
    ]);
    expect(audit.entries).toEqual([
      AssistantSettingsChanged.entry('assistant-settings', {
        before: { version: 0, enabled: false },
        after: { version: 1, enabled: true },
      }),
    ]);

    const again = await set(on({ welcomeText: 'Hello' }), 1);
    expect(again.ok && again.value.version).toBe(1);
    expect(settings.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);

    const off = await set(on({ enabled: false, welcomeText: 'Hello' }), 1);
    expect(off.ok && off.value.version).toBe(2);
    expect(audit.entries[1]).toEqual(
      AssistantSettingsChanged.entry('assistant-settings', {
        before: { version: 1, enabled: true },
        after: { version: 2, enabled: false },
      }),
    );
  });

  it('answers a conflict for a stale version or a lost race, and writes nothing', async () => {
    await set(on());
    expect(await set(on({ guestMessageLimit: 30 }), 0)).toEqual({
      ok: false,
      error: { code: 'assistant.conflict' },
    });
    settings.taken = true;
    expect(await set(on({ guestMessageLimit: 30 }), 1)).toEqual({
      ok: false,
      error: { code: 'assistant.conflict' },
    });
    expect(settings.rows).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
  });

  it('refuses invalid settings and a bad expected version together, writing nothing', async () => {
    const result = await set({ ...DEFAULT_ASSISTANT_SETTINGS, guestMessageLimit: 1000 }, -1);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'expectedVersion', code: 'range' },
          { path: 'guestMessageLimit', code: 'range' },
        ],
      },
    });
    expect(settings.rows).toEqual([]);
  });

  it('lets no one but an admin read or change the settings', async () => {
    expect(await new ViewAssistantSettings(gate, deps).execute(seller(), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await set(on(), 0, seller())).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(settings.rows).toEqual([]);
  });

  describe('the storefront read', () => {
    const OFF = { enabled: false, guestsAllowed: false, replyLanguage: 'buyer', welcomeText: null };

    it('is off by default', async () => {
      expect(await storefront()).toEqual(ok(OFF));
    });

    it('answers the safe subset when on for everyone', async () => {
      await set(on({ users: 'customers-only', replyLanguage: 'english', welcomeText: 'Hi' }));
      expect(await storefront()).toEqual(
        ok({ enabled: true, guestsAllowed: false, replyLanguage: 'english', welcomeText: 'Hi' }),
      );
      await set(on({ welcomeText: 'Hi' }), 1);
      expect(await storefront(undefined)).toEqual(
        ok({ enabled: true, guestsAllowed: true, replyLanguage: 'buyer', welcomeText: 'Hi' }),
      );
    });

    it('stays off without the API key or a model for the chosen tier', async () => {
      await set(on({ welcomeText: 'Hi' }));
      runtime.key = false;
      expect(await storefront()).toEqual(ok(OFF));
      runtime.key = true;
      await set(on({ modelTier: 'balanced', welcomeText: 'Hi' }), 1);
      expect(await storefront()).toEqual(ok(OFF));
    });

    it('stays off for the internal audience and leaves a visitor without a usable key out of a percentage', async () => {
      await set(on({ audience: 'internal' }));
      expect(await storefront()).toEqual(ok(OFF));
      await set(on({ audience: 'percent', audiencePercent: 100 }), 1);
      const shown = await storefront();
      expect(shown.ok && shown.value.enabled).toBe(true);
      for (const bad of [null, 'short', 'x'.repeat(65), 'bad key with spaces!', ['a']]) {
        expect(await storefront(bad)).toEqual(ok(OFF));
      }
    });
  });
});
