import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { RecordingReview } from '../../../../test/support/system-request-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SETTINGS_AUDIT_ACTIONS } from '../domain/audit';
import type {
  MarketSettingChange,
  MarketSettingRecord,
  MarketSettingRepository,
} from './ports/market-setting.repository';
import type { SettingsDependencies } from './settings-dependencies';
import { readSettingValue, SETTING_SUBJECT_KIND } from './settings-flow';
import { SettingsReverter } from './settings-reverter';
import { SettingsFacadeImplementation } from '../presentation/settings.facade';
import { ChangeAiSetting } from './use-cases/change-ai-setting.use-case';
import { ChangeCartModeSetting } from './use-cases/change-cart-mode-setting.use-case';
import { ChangeListPagingSetting } from './use-cases/change-list-paging-setting.use-case';
import { ReadAiDescriptionWriter } from './use-cases/read-ai-description-writer.use-case';
import { ReadCartMode } from './use-cases/read-cart-mode.use-case';
import { ReadListPaging } from './use-cases/read-list-paging.use-case';
import { ChangeMonthlyRevenueTargetSetting } from './use-cases/change-monthly-revenue-target-setting.use-case';
import { ReadMonthlyRevenueTarget } from './use-cases/read-monthly-revenue-target.use-case';
import { ViewMonthlyRevenueTargetSetting } from './use-cases/view-monthly-revenue-target-setting.use-case';
import { ViewAiSettings } from './use-cases/view-ai-settings.use-case';
import { ChangeOfferReviewSettings } from './use-cases/change-offer-review-settings.use-case';
import { ViewOfferReviewSettings } from './use-cases/view-offer-review-settings.use-case';
import { ChangeOfferReviewEmergencyStop } from './use-cases/change-offer-review-emergency-stop.use-case';
import { ViewOfferReviewEmergencyStop } from './use-cases/view-offer-review-emergency-stop.use-case';
import { ReadOfferReviewPolicy as ReadPolicyForStop } from './use-cases/read-offer-review-policy.use-case';
import { ViewCartModeSetting } from './use-cases/view-cart-mode-setting.use-case';
import { ViewListPagingSetting } from './use-cases/view-list-paging-setting.use-case';

// The settings store in memory on both Market fixtures: the default in force before any change,
// a change with its version, history and one audit row, a stale version, a repeat that changes
// nothing, a value outside the definition, acting-as, one Market never seeing another's value, and
// the safe value when the store cannot be read.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-01T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const ACTIONS = new Set<string>(SETTINGS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** Rows keyed by Market and code, as the table keys them; `history` is the insert-only table. */
class MemorySettings implements MarketSettingRepository {
  readonly rows = new Map<string, MarketSettingRecord>();
  readonly history: MarketSettingChange[] = [];
  failReads = false;
  private key = (market: MarketContext, code: string) => `${market.marketId}/${code}`;

  list(market: MarketContext): Promise<readonly MarketSettingRecord[]> {
    if (this.failReads) return Promise.reject(new Error('store down'));
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${market.marketId}/`))
        .map(([, row]) => row),
    );
  }
  find(market: MarketContext, code: string): Promise<MarketSettingRecord | null> {
    if (this.failReads) return Promise.reject(new Error('store down'));
    return Promise.resolve(this.rows.get(this.key(market, code)) ?? null);
  }
  apply(market: MarketContext, change: MarketSettingChange): Promise<boolean> {
    const current = this.rows.get(this.key(market, change.code));
    if ((current?.version ?? 0) !== change.version - 1) return Promise.resolve(false);
    this.rows.set(this.key(market, change.code), {
      code: change.code,
      value: change.value,
      version: change.version,
      updatedAt: change.changedAt,
      updatedBy: change.changedBy,
    });
    this.history.push(change);
    return Promise.resolve(true);
  }
}

describe.each([['AU'], ['ZZ']] as const)('settings store in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  let gate: ReturnType<typeof createUseCaseGate>;
  let store: MemorySettings;
  let audit: RecordingAudit;
  let deps: SettingsDependencies;
  let review: RecordingReview;

  const adminCtx = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'settings-admin-abcd',
    );
  const sellerCtx = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0x5a),
        sessionId: id<'Session'>(0x63),
        sellerId: id<'Seller'>(0x5e1),
      }),
      'settings-seller-abcd',
    );
  const anonymous = testCallContext(market, 'anonymous', 'settings-anon-abcd');
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
    }) as unknown as CallContext;
  const change = (input: Record<string, unknown>, context = adminCtx()) =>
    new ChangeListPagingSetting(gate, deps).execute(context, input);

  beforeEach(() => {
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    store = new MemorySettings();
    audit = new RecordingAudit();
    review = new RecordingReview();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      settings: store,
      audit,
      clock: new FixedClock(T0),
      review,
    };
  });

  it('shows the default (page numbers, version 0) before any change', async () => {
    const view = await new ViewListPagingSetting(gate, deps).execute(adminCtx(), {});
    expect(view.ok && view.value).toEqual([
      {
        code: 'list-paging',
        value: 'pages',
        version: 0,
        updatedAt: null,
        review: { reviewed: false, risk: 'low' },
      },
    ]);
    const paging = await new ReadListPaging(gate, deps).execute(sellerCtx(), {});
    expect(paging.ok && paging.value).toBe('pages');
  });

  it('changes a setting from the version seen, with history and one audit row', async () => {
    const first = await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
    expect(first.ok && first.value).toMatchObject({ value: 'prev-next', version: 1 });
    expect(store.history).toEqual([
      expect.objectContaining({ code: 'list-paging', previousValue: null, value: 'prev-next' }),
    ]);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'settings.market-setting.changed',
      before: { value: 'pages' },
      after: { value: 'prev-next', version: 1 },
    });
    const second = await change({ code: 'list-paging', value: 'pages', expectedVersion: 1 });
    expect(second.ok && second.value.version).toBe(2);
    expect(store.history[1]).toMatchObject({ previousValue: 'prev-next', version: 2 });
    const paging = await new ReadListPaging(gate, deps).execute(adminCtx(), {});
    expect(paging.ok && paging.value).toBe('pages');
  });

  it('refuses a stale version and changes nothing', async () => {
    await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
    const stale = await change({ code: 'list-paging', value: 'pages', expectedVersion: 0 });
    expect(!stale.ok && stale.error.code).toBe('settings.conflict');
    expect(store.history).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
  });

  it('ignores a repeat of the value in force: no history, no audit row, same version', async () => {
    const repeat = await change({ code: 'list-paging', value: 'pages', expectedVersion: 0 });
    expect(repeat.ok && repeat.value).toMatchObject({ value: 'pages', version: 0 });
    expect(store.history).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it.each([
    ['an unknown code', { code: 'nope', value: 'pages', expectedVersion: 0 }, 'code'],
    [
      'a value outside the definition',
      { code: 'list-paging', value: 'x', expectedVersion: 0 },
      'value',
    ],
    ['a missing version', { code: 'list-paging', value: 'pages' }, 'expectedVersion'],
    [
      'a negative version',
      { code: 'list-paging', value: 'pages', expectedVersion: -1 },
      'expectedVersion',
    ],
  ])('refuses %s', async (_name, input, path) => {
    const result = await change(input);
    expect(!result.ok && result.error.code).toBe('validation.failed');
    const fields = !result.ok && 'fields' in result.error ? result.error.fields : [];
    expect(fields.map((field) => field.path)).toContain(path);
    expect(store.history).toHaveLength(0);
  });

  it('refuses a change by anyone but an admin and in an acting-as session', async () => {
    const input = { code: 'list-paging', value: 'prev-next', expectedVersion: 0 };
    for (const context of [sellerCtx(), anonymous, actingAs(adminCtx())]) {
      const result = await change(input, context);
      expect(result.ok).toBe(false);
    }
    expect(store.history).toHaveLength(0);
  });

  it('keeps one Market from seeing the value of another', async () => {
    await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    expect(await store.find(other, 'list-paging')).toBeNull();
    expect((await store.list(other)).length).toBe(0);
  });

  it('answers the safe value (Previous and Next) when the store cannot be read', async () => {
    await change({ code: 'list-paging', value: 'pages', expectedVersion: 0 });
    store.failReads = true;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const paging = await new ReadListPaging(gate, deps).execute(sellerCtx(), {});
      expect(paging.ok && paging.value).toBe('prev-next');
      // The fall-back is never silent: one structured line names the setting and the Market,
      // and carries no error text.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({
        msg: 'settings.read-fell-back-to-safe-value',
        code: 'list-paging',
        reason: 'store-unreadable',
        marketId: code,
      });
    } finally {
      warn.mockRestore();
    }
  });

  describe('Cart mode', () => {
    const changeCart = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeCartModeSetting(gate, deps).execute(context, input);
    const viewCart = (context = adminCtx()) =>
      new ViewCartModeSetting(gate, deps).execute(context, {});

    it('is multi-store at version 0 before any change, and shows only its own setting', async () => {
      const view = await viewCart();
      expect(view.ok && view.value).toEqual([
        {
          code: 'cart-mode',
          value: 'multi-store',
          version: 0,
          updatedAt: null,
          review: { reviewed: false, risk: 'low' },
        },
      ]);
    });

    it('changes from the version seen, with history and one audit row naming before and after', async () => {
      const first = await changeCart({
        code: 'cart-mode',
        value: 'single-store',
        expectedVersion: 0,
      });
      expect(first.ok && first.value).toMatchObject({ value: 'single-store', version: 1 });
      expect(store.history).toEqual([
        expect.objectContaining({
          code: 'cart-mode',
          previousValue: null,
          value: 'single-store',
          changedBy: ADMIN,
        }),
      ]);
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'settings.market-setting.changed',
        targetId: 'cart-mode',
        before: { value: 'multi-store' },
        after: { value: 'single-store', version: 1 },
      });
      const view = await viewCart();
      expect(view.ok && view.value[0]).toMatchObject({ value: 'single-store', version: 1 });
      const back = await changeCart({
        code: 'cart-mode',
        value: 'multi-store',
        expectedVersion: 1,
      });
      expect(back.ok && back.value.version).toBe(2);
      expect(store.history[1]).toMatchObject({ previousValue: 'single-store', version: 2 });
    });

    it('refuses a stale version, a repeat changes nothing, bad input is refused', async () => {
      await changeCart({ code: 'cart-mode', value: 'single-store', expectedVersion: 0 });
      const stale = await changeCart({
        code: 'cart-mode',
        value: 'multi-store',
        expectedVersion: 0,
      });
      expect(!stale.ok && stale.error.code).toBe('settings.conflict');
      const repeat = await changeCart({
        code: 'cart-mode',
        value: 'single-store',
        expectedVersion: 1,
      });
      expect(repeat.ok && repeat.value.version).toBe(1);
      for (const input of [
        { code: 'cart-mode', value: 'both', expectedVersion: 1 },
        { code: 'list-paging', value: 'pages', expectedVersion: 0 },
        { code: 'cart-mode', value: 'multi-store' },
      ]) {
        const result = await changeCart(input);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
      expect(store.history).toHaveLength(1);
      expect(audit.entries).toHaveLength(1);
    });

    it('refuses a change by a seller, an anonymous caller and an acting-as session', async () => {
      const input = { code: 'cart-mode', value: 'single-store', expectedVersion: 0 };
      for (const context of [sellerCtx(), anonymous, actingAs(adminCtx())]) {
        expect((await changeCart(input, context)).ok).toBe(false);
      }
      expect(store.history).toHaveLength(0);
    });

    it('answers the mode through the facade to a guest, a customer and a panel user', async () => {
      const facade = new SettingsFacadeImplementation(
        new ReadAiDescriptionWriter(gate, deps),
        new ReadCartMode(gate, deps),
        new ReadMonthlyRevenueTarget(gate, deps),
      );
      for (const context of [anonymous, sellerCtx(), adminCtx()]) {
        expect(await facade.cartMode(context)).toBe('multi-store');
      }
      await changeCart({ code: 'cart-mode', value: 'single-store', expectedVersion: 0 });
      for (const context of [anonymous, sellerCtx(), adminCtx()]) {
        expect(await facade.cartMode(context)).toBe('single-store');
      }
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(await store.find(other, 'cart-mode')).toBeNull();
    });

    it('answers multi-store when the store cannot be read or the read throws', async () => {
      await changeCart({ code: 'cart-mode', value: 'single-store', expectedVersion: 0 });
      store.failReads = true;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const facade = new SettingsFacadeImplementation(
          new ReadAiDescriptionWriter(gate, deps),
          new ReadCartMode(gate, deps),
          new ReadMonthlyRevenueTarget(gate, deps),
        );
        expect(await facade.cartMode(anonymous)).toBe('multi-store');
      } finally {
        warn.mockRestore();
      }
      const throwing = new SettingsFacadeImplementation(
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadAiDescriptionWriter,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadCartMode,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadMonthlyRevenueTarget,
      );
      expect(await throwing.cartMode(anonymous)).toBe('multi-store');
    });

    it('keeps one Market from seeing the value of another', async () => {
      await changeCart({ code: 'cart-mode', value: 'single-store', expectedVersion: 0 });
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(await store.find(other, 'cart-mode')).toBeNull();
    });
  });

  describe('AI description writer', () => {
    const changeAi = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeAiSetting(gate, deps).execute(context, input);
    const facade = () =>
      new SettingsFacadeImplementation(
        new ReadAiDescriptionWriter(gate, deps),
        new ReadCartMode(gate, deps),
        new ReadMonthlyRevenueTarget(gate, deps),
      );

    it('is off on the fast tier before any change, for the admin view and the facade', async () => {
      const view = await new ViewAiSettings(gate, deps).execute(adminCtx(), {});
      expect(view.ok && view.value).toEqual([
        {
          code: 'ai-description-writer',
          value: 'off',
          version: 0,
          updatedAt: null,
          review: { reviewed: false, risk: 'low' },
        },
        {
          code: 'ai-description-writer-tier',
          value: 'fast',
          version: 0,
          updatedAt: null,
          review: { reviewed: false, risk: 'low' },
        },
      ]);
      expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({
        enabled: false,
        tier: 'fast',
      });
    });

    it('switches on and changes the tier, each with history and one audit row', async () => {
      const on = await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 0 });
      expect(on.ok && on.value).toMatchObject({ value: 'on', version: 1 });
      const tier = await changeAi({
        code: 'ai-description-writer-tier',
        value: 'balanced',
        expectedVersion: 0,
      });
      expect(tier.ok && tier.value).toMatchObject({ value: 'balanced', version: 1 });
      expect(audit.entries.map((entry) => entry.targetId)).toEqual([
        'ai-description-writer',
        'ai-description-writer-tier',
      ]);
      expect(audit.entries[0]).toMatchObject({
        action: 'settings.market-setting.changed',
        before: { value: 'off' },
        after: { value: 'on', version: 1 },
      });
      expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({
        enabled: true,
        tier: 'balanced',
      });
    });

    it('refuses a code that is not an AI setting, and a value outside the definition', async () => {
      for (const input of [
        { code: 'cart-mode', value: 'single-store', expectedVersion: 0 },
        { code: 'ai-description-writer', value: 'yes', expectedVersion: 0 },
        { code: 'ai-description-writer-tier', value: 'smartest', expectedVersion: 0 },
      ]) {
        const result = await changeAi(input);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
      expect(store.history).toHaveLength(0);
    });

    it('refuses a change by a seller, an anonymous caller and an acting-as session', async () => {
      const input = { code: 'ai-description-writer', value: 'on', expectedVersion: 0 };
      for (const context of [sellerCtx(), anonymous, actingAs(adminCtx())]) {
        expect((await changeAi(input, context)).ok).toBe(false);
      }
      expect(store.history).toHaveLength(0);
    });

    it('keeps the switch of one Market from turning the writer on in another', async () => {
      await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 0 });
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(await store.find(other, 'ai-description-writer')).toBeNull();
    });

    it('is off when the store cannot be read, and the facade never throws', async () => {
      await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 0 });
      store.failReads = true;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({
          enabled: false,
          tier: 'fast',
        });
      } finally {
        warn.mockRestore();
      }
      const throwing = new SettingsFacadeImplementation(
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadAiDescriptionWriter,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadCartMode,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadMonthlyRevenueTarget,
      );
      expect(await throwing.aiDescriptionWriter(sellerCtx())).toEqual({
        enabled: false,
        tier: 'fast',
      });
    });
  });

  describe('review in System requests (area marketplace)', () => {
    const revert = (request: { before: unknown; after: unknown }, context = adminCtx()) =>
      new SettingsReverter(deps).revert(context, {
        requestId: id<'SystemRequest'>(0x5e1),
        subjectRef: 'list-paging',
        before: request.before as Record<string, string>,
        after: request.after as Record<string, string>,
      });

    it('opens nothing and needs no note where the Market does not review the area', async () => {
      const saved = await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      expect(saved.ok && saved.value).toMatchObject({
        version: 1,
        review: { reviewed: false, risk: 'low' },
        request: null,
      });
      expect(review.asked).toEqual(['marketplace']);
      expect(review.opened).toHaveLength(0);
    });

    it('opens a review with the values before and after and the note, and names the request', async () => {
      review.review('marketplace', 'medium');
      const view = await new ViewListPagingSetting(gate, deps).execute(adminCtx(), {});
      expect(view.ok && view.value[0]?.review).toEqual({ reviewed: true, risk: 'medium' });
      const saved = await change({
        code: 'list-paging',
        value: 'prev-next',
        expectedVersion: 0,
        note: 'Shorter pages for phones',
      });
      expect(saved.ok && saved.value).toMatchObject({
        value: 'prev-next',
        version: 1,
        review: { reviewed: true, risk: 'medium' },
        request: { number: 1 },
      });
      expect(review.opened).toEqual([
        {
          area: 'marketplace',
          subjectKind: SETTING_SUBJECT_KIND,
          subjectRef: 'list-paging',
          before: { value: 'pages' },
          after: { value: 'prev-next' },
          note: 'Shorter pages for phones',
        },
      ]);
    });

    it('refuses the change when the reviewed area gets no note, and a repeat opens nothing', async () => {
      review.review('marketplace');
      const missing = await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      expect(!missing.ok && missing.error).toEqual({
        code: 'validation.failed',
        fields: [{ path: 'note', code: 'required' }],
      });
      expect(review.opened).toHaveLength(0);
      const repeat = await new ChangeCartModeSetting(gate, deps).execute(adminCtx(), {
        code: 'cart-mode',
        value: 'multi-store',
        expectedVersion: 0,
      });
      expect(repeat.ok && repeat.value.request).toBeNull();
      expect(review.opened).toHaveLength(0);
    });

    it('answers the recorder refusal as its own', async () => {
      review.failNext = true;
      const refused = await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      expect(!refused.ok && refused.error.code).toBe('access.denied');
    });

    it('restores the value before while the setting still holds the value after', async () => {
      await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      audit.entries.length = 0;
      expect(await revert({ before: { value: 'pages' }, after: { value: 'prev-next' } })).toBe(
        'reverted',
      );
      expect(await store.find(market, 'list-paging')).toMatchObject({
        value: 'pages',
        version: 2,
        updatedBy: ADMIN,
      });
      expect(store.history[1]).toMatchObject({ previousValue: 'prev-next', value: 'pages' });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'settings.market-setting.changed',
          targetId: 'list-paging',
          before: { value: 'prev-next' },
          after: { value: 'pages', version: 2 },
        }),
      ]);
      // The revert opens no new review.
      expect(review.opened).toHaveLength(0);
    });

    it('reviews the AI settings at high risk, and never switches the writer back on by a revert', async () => {
      review.review('marketplace');
      const changeAi = (input: Record<string, unknown>) =>
        new ChangeAiSetting(gate, deps).execute(adminCtx(), { ...input, note: 'AI review' });
      await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 0 });
      await changeAi({ code: 'ai-description-writer', value: 'off', expectedVersion: 1 });
      await changeAi({ code: 'ai-description-writer-tier', value: 'balanced', expectedVersion: 0 });
      expect(review.opened.map((opened) => opened.risk)).toEqual(['high', 'high', 'high']);
      const reverter = new SettingsReverter(deps);
      const revertAi = (subjectRef: string, before: string, after: string) =>
        reverter.revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e3),
          subjectRef,
          before: { value: before },
          after: { value: after },
        });
      // Rejecting the "off" would switch AI on: refused, the writer stays off.
      expect(await revertAi('ai-description-writer', 'on', 'off')).toBe('not-permitted');
      expect(await store.find(market, 'ai-description-writer')).toMatchObject({ value: 'off' });
      expect(await revertAi('ai-description-writer-tier', 'fast', 'balanced')).toBe('reverted');
      // Switching AI off again through a revert is allowed (the fail-closed direction).
      await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 2 });
      expect(await revertAi('ai-description-writer', 'off', 'on')).toBe('reverted');
      expect(await store.find(market, 'ai-description-writer')).toMatchObject({ value: 'off' });
      // A list setting is never reviewed above the area's risk.
      await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0, note: 'x' });
      expect(review.opened.at(-1)?.risk).toBeUndefined();
    });

    it('restores over the default when the setting has no row yet, as version 1', async () => {
      expect(await revert({ before: { value: 'prev-next' }, after: { value: 'pages' } })).toBe(
        'reverted',
      );
      expect(await store.find(market, 'list-paging')).toMatchObject({
        value: 'prev-next',
        version: 1,
      });
    });

    it('answers gone for a value before that is not a value of the setting', async () => {
      for (const before of [{ value: 25 }, { value: null }, {}]) {
        expect(await revert({ before, after: { value: 'pages' } })).toBe('gone');
      }
      expect(store.history).toHaveLength(0);
    });

    it('refuses to revert as anyone but a signed-in admin acting as themselves', async () => {
      const request = { before: { value: 'pages' }, after: { value: 'prev-next' } };
      await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      for (const context of [sellerCtx(), anonymous, actingAs(adminCtx())]) {
        await expect(revert(request, context)).rejects.toThrow();
      }
      expect(store.history).toHaveLength(1);
    });

    it('answers changed-since once the setting moved on, and gone for a value no longer defined', async () => {
      await change({ code: 'list-paging', value: 'prev-next', expectedVersion: 0 });
      await change({ code: 'list-paging', value: 'pages', expectedVersion: 1 });
      expect(await revert({ before: { value: 'pages' }, after: { value: 'prev-next' } })).toBe(
        'changed-since',
      );
      expect(await revert({ before: { value: 'endless' }, after: { value: 'pages' } })).toBe(
        'gone',
      );
      expect(store.history).toHaveLength(2);
      const unknown = await new SettingsReverter(deps).revert(adminCtx(), {
        requestId: id<'SystemRequest'>(0x5e2),
        subjectRef: 'retired-setting',
        before: { value: 'a' },
        after: { value: 'b' },
      });
      expect(unknown).toBe('gone');
    });

    it('labels each setting by its name for the queue, and no unknown code', async () => {
      const labels = await new SettingsReverter(deps).describe(adminCtx(), [
        'list-paging',
        'cart-mode',
        'retired-setting',
      ]);
      expect([...labels]).toEqual([
        ['list-paging', 'List paging'],
        ['cart-mode', 'Cart mode'],
      ]);
    });
  });

  describe('monthly revenue target', () => {
    const currency = markets.get(market.marketId).defaultCurrency;
    const otherCurrency = currency === 'AUD' ? 'NZD' : 'AUD';
    const changeTarget = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeMonthlyRevenueTargetSetting(gate, deps, {
        currencyOf: (m) => markets.get(m.marketId).defaultCurrency,
      }).execute(context, input);
    const facade = () =>
      new SettingsFacadeImplementation(
        new ReadAiDescriptionWriter(gate, deps),
        new ReadCartMode(gate, deps),
        new ReadMonthlyRevenueTarget(gate, deps),
      );

    it('has no target before any change, then sets it in the Market currency with history and an amount audit row', async () => {
      const view = await new ViewMonthlyRevenueTargetSetting(gate, deps).execute(adminCtx(), {});
      expect(view.ok && view.value[0]).toMatchObject({
        code: 'monthly-revenue-target',
        value: 'none',
        version: 0,
      });
      expect(await facade().monthlyRevenueTarget(adminCtx())).toEqual({ ok: true, value: null });
      const set = await changeTarget({
        target: { amount: '24000000', currency },
        expectedVersion: 0,
      });
      expect(set.ok && set.value).toMatchObject({ value: `${currency}:24000000`, version: 1 });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'settings.monthly-revenue-target.changed',
          before: { target: null },
          after: { target: { amount: 24000000n, currency }, version: 1 },
        }),
      ]);
      expect(await facade().monthlyRevenueTarget(adminCtx())).toEqual({
        ok: true,
        value: { amount: 24000000n, currency },
      });
      const cleared = await changeTarget({ target: null, expectedVersion: 1 });
      expect(cleared.ok && cleared.value).toMatchObject({ value: 'none', version: 2 });
      expect(store.history.map((row) => row.value)).toEqual([`${currency}:24000000`, 'none']);
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(await store.find(other, 'monthly-revenue-target')).toBeNull();
    });

    it.each([
      [{ amount: '0', currency: 'CUR' }, ['target.amount']],
      [{ amount: '-5', currency: 'CUR' }, ['target.amount']],
      [{ amount: 100, currency: 'CUR' }, ['target.amount']],
      [{ amount: '1234567890123456', currency: 'CUR' }, ['target.amount']],
      [{ amount: '100', currency: 'OTHER' }, ['target.currency']],
      [{ amount: '100', currency: 'CUR', extra: 1 }, ['target']],
      ['100', ['target']],
      [undefined, ['target']],
    ])('refuses the target %j', async (target, paths) => {
      const fill = (value: unknown): unknown =>
        value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [
                key,
                item === 'CUR' ? currency : item === 'OTHER' ? otherCurrency : item,
              ]),
            )
          : value;
      const out = await changeTarget({ target: fill(target), expectedVersion: 0 });
      expect(!out.ok && out.error.code).toBe('validation.failed');
      expect(!out.ok && 'fields' in out.error && out.error.fields.map((f) => f.path)).toEqual(
        paths,
      );
      expect(store.history).toHaveLength(0);
    });

    it('refuses acting-as and a stale version, and reverts to the target before', async () => {
      const acting = await changeTarget(
        { target: { amount: '100', currency }, expectedVersion: 0 },
        actingAs(adminCtx()),
      );
      expect(!acting.ok && acting.error.code).toBe('access.denied');
      await changeTarget({ target: { amount: '100', currency }, expectedVersion: 0 });
      const stale = await changeTarget({ target: { amount: '200', currency }, expectedVersion: 0 });
      expect(!stale.ok && stale.error.code).toBe('settings.conflict');
      await changeTarget({ target: { amount: '200', currency }, expectedVersion: 1 });
      const reverted = await new SettingsReverter(deps).revert(adminCtx(), {
        requestId: id<'SystemRequest'>(0x5e3),
        subjectRef: 'monthly-revenue-target',
        before: { value: `${currency}:100` },
        after: { value: `${currency}:200` },
      });
      expect(reverted).toBe('reverted');
      expect(store.rows.get(`${code}/monthly-revenue-target`)?.value).toBe(`${currency}:100`);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'settings.monthly-revenue-target.changed',
        before: { target: { amount: 200n, currency } },
        after: { target: { amount: 100n, currency }, version: 3 },
      });
    });

    it('answers unavailable, never "no target", when the store cannot be read', async () => {
      store.failReads = true;
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        expect(await facade().monthlyRevenueTarget(adminCtx())).toEqual({
          ok: false,
          error: { code: 'access.unavailable' },
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the Offer review policy (risk-based Offer approval)', () => {
    const saveOfferReview = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeOfferReviewSettings(gate, deps).execute(context, input);

    it('shows the launch defaults with version 0 before any change', async () => {
      const view = await new ViewOfferReviewSettings(gate, deps).execute(adminCtx(), {});
      expect(
        view.ok && view.value.map(({ code, value, version }) => [code, value, version]),
      ).toEqual([
        ['offer-review-mode', 'risk-based', 0],
        ['offer-review-probation-offers', '10', 0],
        ['offer-review-reference-sellers', '3', 0],
        ['offer-review-price-band', '50', 0],
        ['offer-review-sampling', '5', 0],
        ['offer-review-certificate-badges', 'review', 0],
      ]);
    });

    it('saves several settings in one write, each with its history and audit row', async () => {
      const saved = await saveOfferReview({
        changes: [
          { code: 'offer-review-probation-offers', value: '20', expectedVersion: 0 },
          { code: 'offer-review-sampling', value: 10, expectedVersion: 0 },
          { code: 'offer-review-mode', value: 'all', expectedVersion: 0 },
        ],
      });
      expect(
        saved.ok && saved.value.map(({ code, value, version }) => [code, value, version]),
      ).toEqual([
        ['offer-review-probation-offers', '20', 1],
        ['offer-review-sampling', '10', 1],
        ['offer-review-mode', 'all', 1],
      ]);
      expect(store.history.map((row) => [row.code, row.previousValue, row.value])).toEqual([
        ['offer-review-probation-offers', null, '20'],
        ['offer-review-sampling', null, '10'],
        ['offer-review-mode', null, 'all'],
      ]);
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'settings.market-setting.number-changed',
          targetId: 'offer-review-probation-offers',
          before: { value: 10 },
          after: { value: 20, version: 1 },
        }),
        expect.objectContaining({
          action: 'settings.market-setting.number-changed',
          targetId: 'offer-review-sampling',
          before: { value: 5 },
          after: { value: 10, version: 1 },
        }),
        expect.objectContaining({
          action: 'settings.market-setting.changed',
          targetId: 'offer-review-mode',
          before: { value: 'risk-based' },
          after: { value: 'all', version: 1 },
        }),
      ]);
    });

    it('saves nothing when any one version is stale', async () => {
      await saveOfferReview({
        changes: [{ code: 'offer-review-price-band', value: '40', expectedVersion: 0 }],
      });
      const stale = await saveOfferReview({
        changes: [
          { code: 'offer-review-sampling', value: '7', expectedVersion: 0 },
          { code: 'offer-review-price-band', value: '30', expectedVersion: 0 },
        ],
      });
      expect(!stale.ok && stale.error.code).toBe('settings.conflict');
      expect(store.history).toHaveLength(1);
      expect(await store.find(market, 'offer-review-sampling')).toBeNull();
    });

    it.each([
      ['a number below its bounds', { code: 'offer-review-reference-sellers', value: '1' }],
      ['a number above its bounds', { code: 'offer-review-sampling', value: '101' }],
      ['a number with a leading zero', { code: 'offer-review-price-band', value: '050' }],
      ['a fraction', { code: 'offer-review-probation-offers', value: '1.5' }],
      ['an exponent', { code: 'offer-review-probation-offers', value: '1e1' }],
      ['a negative number', { code: 'offer-review-probation-offers', value: -1 }],
      ['a choice outside the list', { code: 'offer-review-mode', value: 'some' }],
      ['a setting of another page', { code: 'list-paging', value: 'prev-next' }],
      ['an unknown setting', { code: 'offer-review-anything', value: '1' }],
    ])('refuses %s and saves nothing', async (_name, change) => {
      const refused = await saveOfferReview({
        changes: [
          { code: 'offer-review-sampling', value: '6', expectedVersion: 0 },
          { ...change, expectedVersion: 0 },
        ],
      });
      expect(!refused.ok && refused.error.code).toBe('validation.failed');
      expect(store.history).toHaveLength(0);
    });

    it('accepts each bound itself, as a number or as decimal text', async () => {
      const saved = await saveOfferReview({
        changes: [
          { code: 'offer-review-probation-offers', value: 0, expectedVersion: 0 },
          { code: 'offer-review-reference-sellers', value: '20', expectedVersion: 0 },
          { code: 'offer-review-price-band', value: '200', expectedVersion: 0 },
          { code: 'offer-review-sampling', value: '100', expectedVersion: 0 },
        ],
      });
      expect(saved.ok && saved.value.map((row) => row.value)).toEqual(['0', '20', '200', '100']);
      const lower = await saveOfferReview({
        changes: [
          { code: 'offer-review-reference-sellers', value: '2', expectedVersion: 1 },
          { code: 'offer-review-price-band', value: 5, expectedVersion: 1 },
          { code: 'offer-review-probation-offers', value: '100', expectedVersion: 1 },
        ],
      });
      expect(lower.ok && lower.value.map((row) => row.value)).toEqual(['2', '5', '100']);
    });

    it('answers each safe value when the store cannot be read or holds a value out of bounds', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const SAFE = {
        'offer-review-mode': 'all',
        'offer-review-probation-offers': '100',
        'offer-review-reference-sellers': '20',
        'offer-review-price-band': '5',
        'offer-review-sampling': '100',
        'offer-review-certificate-badges': 'review',
      };
      try {
        store.failReads = true;
        for (const [setting, safe] of Object.entries(SAFE)) {
          expect(await readSettingValue(deps, adminCtx(), setting)).toBe(safe);
        }
        store.failReads = false;
        // A row changed by hand to a value the definition does not allow is never passed on.
        store.rows.set(`${market.marketId}/offer-review-price-band`, {
          code: 'offer-review-price-band',
          value: '0',
          version: 1,
          updatedAt: T0,
          updatedBy: ADMIN,
        });
        expect(await readSettingValue(deps, adminCtx(), 'offer-review-price-band')).toBe('5');
        expect(await readSettingValue(deps, adminCtx(), 'offer-review-sampling')).toBe('5');
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'offer-review-price-band',
            reason: 'stored-value-invalid',
          }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('refuses the whole page without a note where the area is reviewed, and saves nothing', async () => {
      review.review('marketplace');
      const refused = await saveOfferReview({
        changes: [
          { code: 'offer-review-sampling', value: '6', expectedVersion: 0 },
          { code: 'offer-review-mode', value: 'all', expectedVersion: 0 },
        ],
      });
      expect(!refused.ok && refused.error.code).toBe('validation.failed');
      expect(review.opened).toHaveLength(0);
      expect(!refused.ok && refused.error).toMatchObject({ fields: [{ path: 'note' }] });
      expect(store.history).toHaveLength(0);
    });

    it('refuses an empty list, a setting named twice, and a list that is not one', async () => {
      const twice = { code: 'offer-review-sampling', value: '6', expectedVersion: 0 };
      for (const changes of [[], [twice, twice], 'offer-review-sampling', undefined]) {
        const refused = await saveOfferReview({ changes });
        expect(!refused.ok && refused.error.code).toBe('validation.failed');
      }
      expect(store.history).toHaveLength(0);
    });

    it('refuses anyone but an admin acting as themselves', async () => {
      const changes = [{ code: 'offer-review-sampling', value: '6', expectedVersion: 0 }];
      for (const context of [sellerCtx(), actingAs(adminCtx())]) {
        const refused = await saveOfferReview({ changes }, context);
        expect(!refused.ok && refused.error.code).toBe('access.denied');
      }
      expect(store.history).toHaveLength(0);
    });

    it('opens one review request per changed setting, and a revert restores a number', async () => {
      review.review('marketplace');
      await saveOfferReview({
        changes: [
          { code: 'offer-review-probation-offers', value: '0', expectedVersion: 0 },
          { code: 'offer-review-certificate-badges', value: 'automatic', expectedVersion: 0 },
        ],
        note: 'Launch sellers are known to the team',
      });
      expect(review.opened.map((opened) => [opened.subjectRef, opened.risk])).toEqual([
        ['offer-review-probation-offers', 'high'],
        ['offer-review-certificate-badges', 'high'],
      ]);
      const outcome = await new SettingsReverter(deps).revert(adminCtx(), {
        requestId: id<'SystemRequest'>(0x5e4),
        subjectRef: 'offer-review-probation-offers',
        before: { value: '10' },
        after: { value: '0' },
      });
      expect(outcome).toBe('reverted');
      expect(await store.find(market, 'offer-review-probation-offers')).toMatchObject({
        value: '10',
        version: 2,
      });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'settings.market-setting.number-changed',
        before: { value: 0 },
        after: { value: 10, version: 2 },
      });
    });
  });
  describe('the Offer review emergency stop (R0)', () => {
    const names = {
      namesOf: (_c: CallContext, ids: readonly string[]) =>
        Promise.resolve(new Map(ids.map((accountId) => [accountId, 'Leila Admin']))),
    };
    const view = (context = adminCtx()) =>
      new ViewOfferReviewEmergencyStop(gate, { settings: deps, names }).execute(context, {});
    const stop = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeOfferReviewEmergencyStop(gate, deps).execute(context, input);

    it('is off by default, with no switch time and no name', async () => {
      expect(await view()).toEqual({
        ok: true,
        value: { on: false, version: 0, changedAt: null, changedBy: null },
      });
    });

    it('always needs a reason, even where settings changes are not reviewed', async () => {
      for (const note of [undefined, '', '   ', 'x'.repeat(501)]) {
        expect(await stop({ value: 'on', expectedVersion: 0, note })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
        });
      }
      expect(store.history).toHaveLength(0);
    });

    it('switches on at once, audited; the banner names who and when, and the policy reads it', async () => {
      const saved = await stop({ value: 'on', expectedVersion: 0, note: 'Fraud wave' });
      expect(saved.ok && saved.value.map(({ code, value }) => [code, value])).toEqual([
        ['offer-review-emergency-stop', 'on'],
      ]);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'settings.market-setting.changed',
        targetId: 'offer-review-emergency-stop',
        before: { value: 'off' },
        after: { value: 'on', version: 1 },
      });
      const shown = await view();
      expect(shown.ok && shown.value).toMatchObject({
        on: true,
        version: 1,
        changedBy: 'Leila Admin',
      });
      const policy = await new ReadPolicyForStop(gate, deps).execute(anonymous, {});
      expect(policy.ok && policy.value.emergencyStop).toBe(true);
    });

    it('takes no other code and no other value', async () => {
      expect((await stop({ value: 'maybe', expectedVersion: 0, note: 'x' })).ok).toBe(false);
      const page = await new ChangeOfferReviewSettings(gate, deps).execute(adminCtx(), {
        changes: [{ code: 'offer-review-emergency-stop', value: 'on', expectedVersion: 0 }],
        note: 'x',
      });
      expect(page.ok).toBe(false);
    });

    it('shows the banner to admins only', async () => {
      expect(await view(sellerCtx())).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect((await view(anonymous)).ok).toBe(false);
    });
  });
});
