import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
import type { AccessDecision, StepUpProofConsumer } from '../../../platform/authz';
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
import { ReadOfferQueueBacklogLimits } from './use-cases/read-offer-queue-backlog-limits.use-case';
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
import { ChangeAiGatewayEmergencyStop } from './use-cases/change-ai-gateway-emergency-stop.use-case';
import { ChangeAiGatewayLimits } from './use-cases/change-ai-gateway-limits.use-case';
import { ViewAiGatewaySettings } from './use-cases/view-ai-gateway-settings.use-case';
import { SettingsAiGatewayControls } from './ai-gateway-controls-reader';
import { NO_CAPS, NO_MODEL_LISTS } from '../../../platform/ai/gateway-controls';
import type { AiModelChoices, ModelChoiceProblem } from '../../../platform/ai/model-choices';
import { ChangeAiModels } from './use-cases/change-ai-models.use-case';
import { ViewAiModels } from './use-cases/view-ai-models.use-case';

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
  /** The step-up proofs spent, and whether the admin has a fresh one left. */
  let spentProofs: string[];
  let proofLeft: boolean;
  const stepUp: StepUpProofConsumer = {
    consume: (_context: CallContext, actionKey: string) => {
      if (!proofLeft) return Promise.resolve(err({ code: 'second-factor.required', actionKey }));
      spentProofs.push(actionKey);
      return Promise.resolve(ok({ sessionId: id<'Session'>(0x99), verifiedAt: T0 }));
    },
  };

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
      stepUp,
    };
    spentProofs = [];
    proofLeft = true;
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

    it('is off before any change, for the admin view and the facade', async () => {
      const view = await new ViewAiSettings(gate, deps).execute(adminCtx(), {});
      expect(view.ok && view.value).toEqual([
        {
          code: 'ai-description-writer',
          value: 'off',
          version: 0,
          updatedAt: null,
          review: { reviewed: false, risk: 'low' },
        },
      ]);
      expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({ enabled: false });
    });

    it('switches on with history and one audit row', async () => {
      const on = await changeAi({ code: 'ai-description-writer', value: 'on', expectedVersion: 0 });
      expect(on.ok && on.value).toMatchObject({ value: 'on', version: 1 });
      expect(audit.entries.map((entry) => entry.targetId)).toEqual(['ai-description-writer']);
      expect(audit.entries[0]).toMatchObject({
        action: 'settings.market-setting.changed',
        before: { value: 'off' },
        after: { value: 'on', version: 1 },
      });
      expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({ enabled: true });
    });

    it('treats a stored row of the removed tier setting as gone: never shown, changed, read or restored (G4d1)', async () => {
      // A row saved before G4d1 stays in the store (no setting is deleted, ADR-0026 decision 4).
      store.rows.set(`${market.marketId}/ai-description-writer-tier`, {
        code: 'ai-description-writer-tier',
        value: 'balanced',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      const view = await new ViewAiSettings(gate, deps).execute(adminCtx(), {});
      expect(view.ok && view.value.map((setting) => setting.code)).toEqual([
        'ai-description-writer',
      ]);
      expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({ enabled: false });
      const change = await changeAi({
        code: 'ai-description-writer-tier',
        value: 'fast',
        expectedVersion: 1,
      });
      expect(change).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'code', code: 'value' }] },
      });
      const reverter = new SettingsReverter(deps);
      expect(
        await reverter.revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e4),
          subjectRef: 'ai-description-writer-tier',
          before: { value: 'fast' },
          after: { value: 'balanced' },
        }),
      ).toBe('gone');
      expect(await reverter.describe(adminCtx(), ['ai-description-writer-tier'])).toEqual(
        new Map(),
      );
      expect(store.history).toHaveLength(0);
      expect(audit.entries).toHaveLength(0);
    });

    it('refuses a code that is not an AI setting, and a value outside the definition', async () => {
      for (const input of [
        { code: 'cart-mode', value: 'single-store', expectedVersion: 0 },
        { code: 'ai-description-writer', value: 'yes', expectedVersion: 0 },
        { code: 'ai-description-writer-tier', value: 'balanced', expectedVersion: 0 },
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
        expect(await facade().aiDescriptionWriter(sellerCtx())).toEqual({ enabled: false });
      } finally {
        warn.mockRestore();
      }
      const throwing = new SettingsFacadeImplementation(
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadAiDescriptionWriter,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadCartMode,
        { execute: () => Promise.reject(new Error('boom')) } as unknown as ReadMonthlyRevenueTarget,
      );
      expect(await throwing.aiDescriptionWriter(sellerCtx())).toEqual({ enabled: false });
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
      expect(review.opened.map((opened) => opened.risk)).toEqual(['high', 'high']);
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
        ['offer-review-backlog-count', '50', 0],
        ['offer-review-backlog-hours', '24', 0],
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

    it('saves the queue backlog limits and hands them to the system actor through the facade', async () => {
      const facade = new SettingsFacadeImplementation(
        new ReadAiDescriptionWriter(gate, deps),
        new ReadCartMode(gate, deps),
        new ReadMonthlyRevenueTarget(gate, deps),
        undefined,
        new ReadOfferQueueBacklogLimits(gate, deps),
      );
      const system = testCallContext(market, 'system', 'settings-sys-abcd');
      expect(await facade.offerQueueBacklogLimits(system)).toEqual({ count: 50, hours: 24 });
      const saved = await saveOfferReview({
        changes: [
          { code: 'offer-review-backlog-count', value: '120', expectedVersion: 0 },
          { code: 'offer-review-backlog-hours', value: 48, expectedVersion: 0 },
        ],
      });
      expect(saved.ok).toBe(true);
      expect(await facade.offerQueueBacklogLimits(system)).toEqual({ count: 120, hours: 48 });
      for (const bad of [
        { code: 'offer-review-backlog-count', value: '0', expectedVersion: 1 },
        { code: 'offer-review-backlog-hours', value: '721', expectedVersion: 1 },
      ]) {
        expect((await saveOfferReview({ changes: [bad] })).ok).toBe(false);
      }
      // An admin is not the system actor: the use case refuses it and the facade answers nothing.
      expect(await facade.offerQueueBacklogLimits(adminCtx())).toBeNull();
      // An unreadable store answers nothing (the alert acts on no guess), not the safe values.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        store.failReads = true;
        expect(await facade.offerQueueBacklogLimits(system)).toBeNull();
        store.failReads = false;
      } finally {
        warn.mockRestore();
      }
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
        'offer-review-backlog-count': '50',
        'offer-review-backlog-hours': '24',
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
      for (const note of [undefined, '', '   ']) {
        expect(await stop({ value: 'on', expectedVersion: 0, note })).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
        });
      }
      expect(await stop({ value: 'on', expectedVersion: 0, note: 'x'.repeat(501) })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'too-long' }] },
      });
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

    it('spends a fresh two-step proof of the admin, and saves nothing without one', async () => {
      proofLeft = false;
      expect(await stop({ value: 'on', expectedVersion: 0, note: 'Fraud wave' })).toEqual({
        ok: false,
        error: {
          code: 'second-factor.required',
          actionKey: 'settings.offer-review-emergency-stop.change',
        },
      });
      expect(store.history).toHaveLength(0);
      proofLeft = true;
      expect((await stop({ value: 'on', expectedVersion: 0, note: 'Fraud wave' })).ok).toBe(true);
      expect(spentProofs).toEqual(['settings.offer-review-emergency-stop.change']);
    });

    it('spends a fresh proof for the Offer review page too, and saves nothing without one', async () => {
      const page = () =>
        new ChangeOfferReviewSettings(gate, deps).execute(adminCtx(), {
          changes: [{ code: 'offer-review-sampling', value: '10', expectedVersion: 0 }],
          note: 'x',
        });
      proofLeft = false;
      expect(await page()).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: 'settings.offer-review.change' },
      });
      expect(store.history).toHaveLength(0);
      proofLeft = true;
      expect((await page()).ok).toBe(true);
      expect(spentProofs).toEqual(['settings.offer-review.change']);
    });

    it('spends no proof on a stale version', async () => {
      expect((await stop({ value: 'on', expectedVersion: 3, note: 'x' })).ok).toBe(false);
      expect(spentProofs).toEqual([]);
    });

    it('is never switched off by a rejected review; a rejected "off" is restored on', async () => {
      const reverter = new SettingsReverter(deps);
      await stop({ value: 'on', expectedVersion: 0, note: 'Fraud wave' });
      expect(
        await reverter.revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e2),
          subjectRef: 'offer-review-emergency-stop',
          before: { value: 'off' },
          after: { value: 'on' },
        }),
      ).toBe('not-permitted');
      await stop({ value: 'off', expectedVersion: 1, note: 'Over' });
      expect(
        await reverter.revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e2),
          subjectRef: 'offer-review-emergency-stop',
          before: { value: 'on' },
          after: { value: 'off' },
        }),
      ).toBe('reverted');
    });

    it('shows the banner to admins only', async () => {
      expect(await view(sellerCtx())).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect((await view(anonymous)).ok).toBe(false);
    });
  });

  describe('the AI Gateway settings (G4, docs/design/domain/platform-ai.md section 8)', () => {
    const limits = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeAiGatewayLimits(gate, deps).execute(context, input);
    const aiStop = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeAiGatewayEmergencyStop(gate, deps).execute(context, input);
    const controls = () => new SettingsAiGatewayControls(deps).read(adminCtx());
    const cap = (codeOf: string, value: unknown, expectedVersion = 0) => ({
      code: codeOf,
      value,
      expectedVersion,
    });
    /** No row: no cap but the buyer chat's own, whose defaults are the assistant's former ones (G4d2). */
    const DEFAULT_CAPS = {
      ...NO_CAPS,
      capabilities: { 'assistant.buyer-chat': { day: 10_000_000, month: 200_000_000 } },
    };

    it('shows the stop off and every cap none by default (the evaluation budget 0, G4c; the buyer chat its own defaults, G4d2); the gateway reads no other cap and no stop', async () => {
      const view = await new ViewAiGatewaySettings(gate, deps).execute(adminCtx(), {});
      expect(
        view.ok && view.value.map(({ code, value, version }) => [code, value, version]),
      ).toEqual([
        ['ai-gateway-emergency-stop', 'off', 0],
        ['ai-cap-market-day', 'none', 0],
        ['ai-cap-market-month', 'none', 0],
        ['ai-cap-capability-day', 'none', 0],
        ['ai-cap-seller-day', 'none', 0],
        ['ai-cap-guest-day', 'none', 0],
        ['ai-cap-evaluation-month', '0', 0],
        ['ai-cap-buyer-chat-day', '10000000', 0],
        ['ai-cap-buyer-chat-month', '200000000', 0],
      ]);
      expect(await controls()).toEqual({
        stopped: false,
        caps: DEFAULT_CAPS,
        models: NO_MODEL_LISTS,
      });
    });

    it('lowers a cap without a two-step code, audited in micro-dollars; the gateway reads it', async () => {
      proofLeft = false;
      const saved = await limits({ changes: [cap('ai-cap-market-day', '5000000')] });
      expect(saved.ok && saved.value.map(({ value, version }) => [value, version])).toEqual([
        ['5000000', 1],
      ]);
      expect(spentProofs).toEqual([]);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'settings.ai-cap.changed',
        targetId: 'ai-cap-market-day',
        before: { microUsd: null },
        after: { microUsd: 5_000_000, version: 1 },
      });
      expect((await controls()).caps).toEqual({ ...DEFAULT_CAPS, marketDay: 5_000_000 });
      // Lower again, and to 0 (nothing allowed): still no code.
      expect((await limits({ changes: [cap('ai-cap-market-day', '0', 1)] })).ok).toBe(true);
      expect((await controls()).caps.marketDay).toBe(0);
    });

    it('needs a fresh two-step code to raise or lift a cap, and saves nothing without one', async () => {
      await limits({ changes: [cap('ai-cap-guest-day', '100')] });
      for (const value of ['101', 'none']) {
        proofLeft = false;
        expect(await limits({ changes: [cap('ai-cap-guest-day', value, 1)] })).toEqual({
          ok: false,
          error: { code: 'second-factor.required', actionKey: 'settings.ai-gateway-limits.raise' },
        });
        expect(store.history).toHaveLength(1);
      }
      // One raise among several lowered caps still needs the code.
      proofLeft = false;
      const mixed = await limits({
        changes: [cap('ai-cap-market-day', '10'), cap('ai-cap-guest-day', '200', 1)],
      });
      expect(mixed.ok).toBe(false);
      proofLeft = true;
      expect((await limits({ changes: [cap('ai-cap-guest-day', '200', 1)] })).ok).toBe(true);
      expect(spentProofs).toEqual(['settings.ai-gateway-limits.raise']);
    });

    it('takes only none or whole micro-dollars up to 10^12, and only cap codes', async () => {
      for (const value of ['-1', '1.5', '07', '1e3', '1000000000001', 5, '', 'off']) {
        const refused = await limits({ changes: [cap('ai-cap-seller-day', value)] });
        expect(refused).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'changes.0.value', code: 'value' }],
          },
        });
      }
      expect((await limits({ changes: [cap('ai-cap-seller-day', '1000000000000')] })).ok).toBe(
        true,
      );
      expect((await limits({ changes: [cap('ai-gateway-emergency-stop', 'on')] })).ok).toBe(false);
      expect((await limits({ changes: [cap('list-paging', 'pages')] })).ok).toBe(false);
    });

    it('switches the stop on with a reason and no code; switching it off needs the code', async () => {
      proofLeft = false;
      expect(await aiStop({ value: 'on', expectedVersion: 0 })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] },
      });
      expect((await aiStop({ value: 'on', expectedVersion: 0, note: 'Leak suspected' })).ok).toBe(
        true,
      );
      expect((await controls()).stopped).toBe(true);
      // The reason is kept on the history row although the area is not reviewed (Hassan, PR 1362).
      expect(store.history.at(-1)).toMatchObject({ value: 'on', note: 'Leak suspected' });
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'settings.market-setting.changed',
        targetId: 'ai-gateway-emergency-stop',
        before: { value: 'off' },
        after: { value: 'on', version: 1 },
      });
      expect(await aiStop({ value: 'off', expectedVersion: 1, note: 'Fixed' })).toEqual({
        ok: false,
        error: {
          code: 'second-factor.required',
          actionKey: 'settings.ai-gateway-emergency-stop.resume',
        },
      });
      expect((await controls()).stopped).toBe(true);
      proofLeft = true;
      expect((await aiStop({ value: 'off', expectedVersion: 1, note: 'Fixed' })).ok).toBe(true);
      expect((await controls()).stopped).toBe(false);
      expect(spentProofs).toEqual(['settings.ai-gateway-emergency-stop.resume']);
    });

    it('is reviewed at high risk where the area is reviewed', async () => {
      review.review('marketplace');
      await aiStop({ value: 'on', expectedVersion: 0, note: 'Leak suspected' });
      await limits({ changes: [cap('ai-cap-market-month', '10')], note: 'Tighter' });
      expect(review.opened.map((opened) => [opened.subjectRef, opened.risk])).toEqual([
        ['ai-gateway-emergency-stop', 'high'],
        ['ai-cap-market-month', 'high'],
      ]);
    });

    it('never allows more AI by a revert: a lowered cap or a stop is not undone, a raise is', async () => {
      const reverter = new SettingsReverter(deps);
      const revert = (subjectRef: string, before: string, after: string) =>
        reverter.revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e3),
          subjectRef,
          before: { value: before },
          after: { value: after },
        });
      await limits({ changes: [cap('ai-cap-market-day', '100')] });
      expect(await revert('ai-cap-market-day', 'none', '100')).toBe('not-permitted');
      await aiStop({ value: 'on', expectedVersion: 0, note: 'Leak suspected' });
      expect(await revert('ai-gateway-emergency-stop', 'off', 'on')).toBe('not-permitted');
      proofLeft = true;
      await limits({ changes: [cap('ai-cap-market-day', '500', 1)] });
      expect(await revert('ai-cap-market-day', '100', '500')).toBe('reverted');
      expect((await controls()).caps.marketDay).toBe(100);
    });

    it('audits a change away from an invalid stored cap as from 0, the value in force (Hassan, PR 1362)', async () => {
      store.rows.set(`${market.marketId}/ai-cap-seller-day`, {
        code: 'ai-cap-seller-day',
        value: 'lots',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      proofLeft = false;
      expect((await limits({ changes: [cap('ai-cap-seller-day', '10', 1)] })).ok).toBe(false);
      proofLeft = true;
      expect((await limits({ changes: [cap('ai-cap-seller-day', '10', 1)] })).ok).toBe(true);
      expect(audit.entries.at(-1)).toMatchObject({
        before: { microUsd: 0 },
        after: { microUsd: 10, version: 2 },
      });
    });

    it('reads a stored value the definition does not allow as the tightest (cap 0, stop on)', async () => {
      store.rows.set(`${market.marketId}/ai-cap-capability-day`, {
        code: 'ai-cap-capability-day',
        value: 'lots',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      store.rows.set(`${market.marketId}/ai-gateway-emergency-stop`, {
        code: 'ai-gateway-emergency-stop',
        value: 'maybe',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      expect(await controls()).toEqual({
        stopped: true,
        caps: { ...DEFAULT_CAPS, capabilityDay: 0 },
        models: NO_MODEL_LISTS,
      });
    });

    describe("the buyer chat's own day and month caps (G4d2)", () => {
      const DAY = 'ai-cap-buyer-chat-day';
      const MONTH = 'ai-cap-buyer-chat-month';
      const chat = async () => (await controls()).caps.capabilities['assistant.buyer-chat'];

      it('lowers either without a two-step code, audited in micro-dollars; the gateway reads them', async () => {
        proofLeft = false;
        const saved = await limits({ changes: [cap(DAY, '5000000'), cap(MONTH, '150000000')] });
        expect(saved.ok).toBe(true);
        expect(spentProofs).toEqual([]);
        expect(audit.entries.slice(-2)).toMatchObject([
          {
            action: 'settings.ai-cap.changed',
            targetId: DAY,
            before: { microUsd: 10_000_000 },
            after: { microUsd: 5_000_000, version: 1 },
          },
          {
            action: 'settings.ai-cap.changed',
            targetId: MONTH,
            before: { microUsd: 200_000_000 },
            after: { microUsd: 150_000_000, version: 1 },
          },
        ]);
        expect(await chat()).toEqual({ day: 5_000_000, month: 150_000_000 });
      });

      it('needs the two-step code to raise or lift either', async () => {
        for (const [code_, value] of [
          [DAY, '10000001'],
          [MONTH, 'none'],
        ] as const) {
          proofLeft = false;
          expect(await limits({ changes: [cap(code_, value)] })).toEqual({
            ok: false,
            error: {
              code: 'second-factor.required',
              actionKey: 'settings.ai-gateway-limits.raise',
            },
          });
        }
        expect(store.history).toHaveLength(0);
        proofLeft = true;
        expect((await limits({ changes: [cap(MONTH, 'none')] })).ok).toBe(true);
        expect(spentProofs).toEqual(['settings.ai-gateway-limits.raise']);
        expect(await chat()).toEqual({ day: 10_000_000, month: null });
      });

      it('refuses a day cap above the month cap, on the page as it would stand, before any proof', async () => {
        proofLeft = true;
        expect(await limits({ changes: [cap(MONTH, '5000000')] })).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: DAY, code: 'range' }],
          },
        });
        expect(await limits({ changes: [cap(DAY, '200000001')] })).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: DAY, code: 'range' }],
          },
        });
        expect(spentProofs).toEqual([]);
        expect(store.history).toHaveLength(0);
        // Both together, day not above month (equal), and `none` on either side pass.
        expect((await limits({ changes: [cap(DAY, '5000000'), cap(MONTH, '5000000')] })).ok).toBe(
          true,
        );
        expect((await limits({ changes: [cap(MONTH, 'none', 1)] })).ok).toBe(true);
        expect((await limits({ changes: [cap(DAY, '900000000', 1)] })).ok).toBe(true);
        expect(await chat()).toEqual({ day: 900_000_000, month: null });
      });

      it('lets a revert leave the day cap above the month cap: advisory, never blocking a rejected review (Hassan L3)', async () => {
        proofLeft = true;
        expect((await limits({ changes: [cap(DAY, '4000000'), cap(MONTH, '4000000')] })).ok).toBe(
          true,
        );
        expect((await limits({ changes: [cap(MONTH, '10000000', 1)] })).ok).toBe(true);
        expect((await limits({ changes: [cap(DAY, '8000000', 1)] })).ok).toBe(true);
        // The reviewer rejects the month raise: the month goes back to 4 000 000 below the day.
        const reverted = await new SettingsReverter(deps).revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e4),
          subjectRef: MONTH,
          before: { value: '4000000' },
          after: { value: '10000000' },
        });
        expect(reverted).toBe('reverted');
        // Both caps reach the gateway, each enforced on its own line (ai-usage.spec).
        expect(await chat()).toEqual({ day: 8_000_000, month: 4_000_000 });
      });

      it('reads an invalid stored value as 0 (nothing allowed)', async () => {
        store.rows.set(`${market.marketId}/${MONTH}`, {
          code: MONTH,
          value: 'lots',
          version: 1,
          updatedAt: T0,
          updatedBy: ADMIN,
        });
        expect(await chat()).toEqual({ day: 10_000_000, month: 0 });
      });
    });

    it('throws when the store cannot be read (the gateway answers off)', async () => {
      store.failReads = true;
      await expect(controls()).rejects.toThrow();
    });

    it('never answers another Market: a cap set elsewhere is not read here', async () => {
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      store.rows.set(`${other.marketId}/ai-cap-market-day`, {
        code: 'ai-cap-market-day',
        value: '1',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      expect((await controls()).caps.marketDay).toBeNull();
    });

    it('is refused in an acting-as session', async () => {
      expect(
        await limits({ changes: [cap('ai-cap-market-day', '1')] }, actingAs(adminCtx())),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await aiStop({ value: 'on', expectedVersion: 0, note: 'x' }, actingAs(adminCtx())),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('the AI model lists (G4b, docs/design/domain/platform-ai.md sections 7 and 8)', () => {
    /**
     * The External models tab's server checks, faked: `fam-a`, `fam-b` and `fam-cheap` may be
     * chosen, anything else is not evaluated, a family twice is a duplicate, and a saver model must
     * be `fam-cheap` (the only one cheaper than the others).
     */
    class FakeChoices implements Pick<AiModelChoices, 'check' | 'options'> {
      readonly checked: unknown[][] = [];
      check(marketId: string, task: string, list: readonly string[], saver: string | null) {
        this.checked.push([marketId, task, [...list], saver]);
        const seen = new Set<string>();
        const problemOf = (family: string): ModelChoiceProblem | null =>
          ['fam-a', 'fam-b', 'fam-cheap'].includes(family) ? null : 'not-evaluated';
        return {
          list: list.map((family) => {
            if (seen.has(family)) return 'duplicate' as const;
            seen.add(family);
            return problemOf(family);
          }),
          saver:
            saver === null
              ? null
              : list.length === 0
                ? ('saver-without-list' as const)
                : (problemOf(saver) ?? (saver === 'fam-cheap' ? null : 'saver-not-cheaper')),
        };
      }
      options() {
        return {
          chat: [{ family: 'fam-a', problem: null }],
          extract: [],
          write: [{ family: 'fam-x', problem: 'not-evaluated' as const }],
          vision: [{ family: 'fam-a', problem: 'task-unsupported' as const }],
        };
      }
    }
    let choices: FakeChoices;
    beforeEach(() => {
      choices = new FakeChoices();
    });
    const change = (input: Record<string, unknown>, context = adminCtx()) =>
      new ChangeAiModels(gate, deps, choices).execute(context, input);
    const controls = () => new SettingsAiGatewayControls(deps).read(adminCtx());
    const set = (code: string, value: unknown, expectedVersion = 0) => ({
      code,
      value,
      expectedVersion,
    });

    it('shows no list, no saver model and 80 % by default, with what each task type may take', async () => {
      const view = await new ViewAiModels(gate, deps, choices).execute(adminCtx(), {});
      expect(
        view.ok && view.value.settings.map(({ code, value, version }) => [code, value, version]),
      ).toEqual([
        ['ai-models-chat', 'none', 0],
        ['ai-models-extract', 'none', 0],
        ['ai-models-write', 'none', 0],
        ['ai-models-vision', 'none', 0],
        ['ai-saver-chat', 'none', 0],
        ['ai-saver-extract', 'none', 0],
        ['ai-saver-write', 'none', 0],
        ['ai-saver-vision', 'none', 0],
        ['ai-saver-percent', '80', 0],
      ]);
      expect(view.ok && view.value.options.write).toEqual([
        { family: 'fam-x', problem: 'not-evaluated' },
      ]);
      expect((await controls()).models).toEqual(NO_MODEL_LISTS);
    });

    it('needs a fresh two-step code for every change, and saves nothing without one', async () => {
      proofLeft = false;
      expect(await change({ changes: [set('ai-models-chat', 'none')] })).toEqual({
        ok: true,
        value: [expect.objectContaining({ code: 'ai-models-chat', value: 'none', version: 0 })],
      });
      for (const changes of [
        [set('ai-models-chat', 'fam-a')],
        [set('ai-saver-percent', '60')],
        [set('ai-saver-percent', '95')],
      ]) {
        proofLeft = false;
        expect(await change({ changes })).toEqual({
          ok: false,
          error: { code: 'second-factor.required', actionKey: 'settings.ai-models.change' },
        });
      }
      expect(store.history).toHaveLength(0);
    });

    it('writes nothing for a save of the values in force, and asks the code when any value changes', async () => {
      proofLeft = false;
      expect((await change({ changes: [set('ai-saver-percent', '80')] })).ok).toBe(true);
      expect(store.history).toHaveLength(0);
      expect(audit.entries.filter((entry) => entry.action.startsWith('settings.ai-'))).toEqual([]);
      expect(review.opened).toEqual([]);
      // A save of the values in force with one real change spends the code.
      expect(
        await change({ changes: [set('ai-saver-percent', '80'), set('ai-models-chat', 'fam-a')] }),
      ).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: 'settings.ai-models.change' },
      });
      expect(store.history).toHaveLength(0);
    });

    it('saves a list, a saver model and the threshold; audited by count; the gateway reads them', async () => {
      proofLeft = true;
      const saved = await change({
        changes: [
          set('ai-models-write', 'fam-a,fam-b'),
          set('ai-saver-write', 'fam-cheap'),
          set('ai-saver-percent', '90'),
        ],
      });
      expect(saved.ok && saved.value.map(({ code, value }) => [code, value])).toEqual([
        ['ai-models-write', 'fam-a,fam-b'],
        ['ai-saver-write', 'fam-cheap'],
        ['ai-saver-percent', '90'],
      ]);
      expect(spentProofs).toEqual(['settings.ai-models.change']);
      expect(choices.checked).toEqual([
        [market.marketId, 'write', ['fam-a', 'fam-b'], 'fam-cheap'],
      ]);
      expect(audit.entries.slice(-3)).toMatchObject([
        {
          action: 'settings.ai-models.changed',
          targetId: 'ai-models-write',
          before: { models: 0 },
          after: { models: 2, version: 1 },
        },
        {
          action: 'settings.ai-models.changed',
          targetId: 'ai-saver-write',
          before: { models: 0 },
          after: { models: 1, version: 1 },
        },
        {
          action: 'settings.market-setting.number-changed',
          targetId: 'ai-saver-percent',
          before: { value: 80 },
          after: { value: 90, version: 1 },
        },
      ]);
      expect((await controls()).models).toEqual({
        lists: { write: ['fam-a', 'fam-b'] },
        savers: { write: 'fam-cheap' },
        saverAtPercent: 90,
      });
    });

    it('refuses a list or a saver model the server checks do not allow, before any code is spent', async () => {
      proofLeft = true;
      expect(await change({ changes: [set('ai-models-chat', 'fam-a,fam-z,fam-a')] })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'ai-models-chat.1', code: 'not-evaluated' },
            { path: 'ai-models-chat.2', code: 'duplicate' },
          ],
        },
      });
      expect(await change({ changes: [set('ai-saver-chat', 'fam-cheap')] })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'ai-saver-chat', code: 'saver-without-list' }],
        },
      });
      expect(
        await change({ changes: [set('ai-models-chat', 'fam-a'), set('ai-saver-chat', 'fam-b')] }),
      ).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'ai-saver-chat', code: 'saver-not-cheaper' }],
        },
      });
      expect(spentProofs).toEqual([]);
      expect(store.history).toHaveLength(0);
    });

    it('checks a saver model alone against the list in force, and only the task types changed', async () => {
      proofLeft = true;
      expect((await change({ changes: [set('ai-models-extract', 'fam-a')] })).ok).toBe(true);
      // A stored list that no longer passes does not block a change of another task type.
      store.rows.set(`${market.marketId}/ai-models-chat`, {
        code: 'ai-models-chat',
        value: 'fam-gone',
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      choices.checked.length = 0;
      proofLeft = true;
      expect((await change({ changes: [set('ai-saver-extract', 'fam-cheap')] })).ok).toBe(true);
      expect(choices.checked).toEqual([[market.marketId, 'extract', ['fam-a'], 'fam-cheap']]);
      // Its saver model is still checked against it.
      proofLeft = true;
      expect(await change({ changes: [set('ai-saver-chat', 'fam-b')] })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: 'ai-saver-chat', code: 'saver-not-cheaper' }],
        },
      });
    });

    it('takes only none or 1 to 3 lowercase families, and a threshold of 50 to 99', async () => {
      proofLeft = true;
      for (const value of [
        '',
        'fam-a,',
        ',fam-a',
        'Fam-A',
        'fam-a,fam-b,fam-cheap,fam-a',
        'fam a',
        `f${'a'.repeat(20)}`,
        5,
      ]) {
        expect(await change({ changes: [set('ai-models-chat', value)] })).toEqual({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'changes.0.value', code: 'value' }],
          },
        });
      }
      expect((await change({ changes: [set('ai-saver-chat', 'fam-a,fam-b')] })).ok).toBe(false);
      for (const value of ['49', '100', '80.5']) {
        expect((await change({ changes: [set('ai-saver-percent', value)] })).ok).toBe(false);
      }
      expect((await change({ changes: [set('ai-cap-market-day', '1')] })).ok).toBe(false);
      expect(store.history).toHaveLength(0);
    });

    it('is reviewed at high risk where the area is reviewed, and a rejected change is reverted', async () => {
      review.review('marketplace');
      proofLeft = true;
      expect(
        (await change({ changes: [set('ai-models-write', 'fam-a')], note: 'Try fam-a' })).ok,
      ).toBe(true);
      expect(review.opened.map((opened) => [opened.subjectRef, opened.risk])).toEqual([
        ['ai-models-write', 'high'],
      ]);
      const reverted = await new SettingsReverter(deps).revert(adminCtx(), {
        requestId: id<'SystemRequest'>(0x5e4),
        subjectRef: 'ai-models-write',
        before: { value: 'none' },
        after: { value: 'fam-a' },
      });
      expect(reverted).toBe('reverted');
      expect((await controls()).models.lists).toEqual({});
    });

    it('restores one setting of a rejected pair alone; the router, not the page, then decides (Hassan 1)', async () => {
      review.review('marketplace');
      proofLeft = true;
      expect(
        (
          await change({
            changes: [set('ai-models-write', 'fam-a'), set('ai-saver-write', 'fam-cheap')],
            note: 'Cheaper fallback',
          })
        ).ok,
      ).toBe(true);
      // The reviewer rejects only the list: the saver model stays with no list to go before.
      expect(
        await new SettingsReverter(deps).revert(adminCtx(), {
          requestId: id<'SystemRequest'>(0x5e5),
          subjectRef: 'ai-models-write',
          before: { value: 'none' },
          after: { value: 'fam-a' },
        }),
      ).toBe('reverted');
      expect((await controls()).models).toEqual({
        lists: {},
        savers: { write: 'fam-cheap' },
        saverAtPercent: 80,
      });
    });

    it('reads a stored value the definition does not allow as no list and a 50 % threshold', async () => {
      for (const [code, value] of [
        ['ai-models-write', 'FAM'],
        ['ai-saver-write', 'fam-a,fam-b'],
        ['ai-saver-percent', '12'],
      ] as const) {
        store.rows.set(`${market.marketId}/${code}`, {
          code,
          value,
          version: 1,
          updatedAt: T0,
          updatedBy: ADMIN,
        });
      }
      expect((await controls()).models).toEqual({ lists: {}, savers: {}, saverAtPercent: 50 });
    });

    it('is refused in an acting-as session and for anyone but an admin', async () => {
      proofLeft = true;
      for (const context of [actingAs(adminCtx()), sellerCtx()]) {
        expect(await change({ changes: [set('ai-models-chat', 'fam-a')] }, context)).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });
  });
});
