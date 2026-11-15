import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { SecurityEventFeed } from '../../../platform/security-events/security-event-feed';
import { evaluateRules, MAX_PUSHED_S2_PER_RULE_RUN } from './evaluate-flow';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SECURITY_RESPOND, SECURITY_VIEW } from '../contracts/permissions';
import { SECURITY_RULES } from '../domain/rules';
import { NO_ROSTER_RECIPIENT } from './deliver-flow';
import { maskAddress } from './respond-flow';
import type { SecurityDependencies } from './security-dependencies';
import {
  FakeEventFeed,
  InMemorySecurityAlerts,
  RecordingMessenger,
  StaticRoster,
  testRoster,
  type FakeEvent,
} from './testing/in-memory-security';
import { AcknowledgeSecurityAlert } from './use-cases/acknowledge-security-alert.use-case';
import { DeliverSecurityAlerts } from './use-cases/deliver-security-alerts.use-case';
import { EvaluateSecurityRules } from './use-cases/evaluate-security-rules.use-case';
import { ListSecurityAlerts } from './use-cases/list-security-alerts.use-case';
import { ResolveSecurityAlert } from './use-cases/resolve-security-alert.use-case';
import { SendSecurityDigests } from './use-cases/send-security-digests.use-case';
import { ViewOnCall } from './use-cases/view-on-call.use-case';
import { ViewSecurityAlert } from './use-cases/view-security-alert.use-case';
import { ViewSecuritySummary } from './use-cases/view-security-summary.use-case';

// SOC package 2 end to end in memory, on both Market fixtures: the rules open alerts from the
// security events of their own Market only, a live alert is raised instead of duplicated, a resolved
// one does not reopen on old events; the delivery job escalates s1 every 10 minutes until someone
// acknowledges, holds s2 for business hours and records every message; the digests go once per
// period; responders acknowledge and resolve under their permissions, s1 only by Ali or Hassan.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALI = id<'Account'>(0xa1);
const HASSAN = id<'Account'>(0xa2);
const KAZEM = id<'Account'>(0xa3);
const VIEWER = id<'Account'>(0xa4);
const VICTIM = id<'Account'>(0xb1);
// Friday 13 November 2026, 11:00 in Sydney: business hours; Hossein is on call.
const FRIDAY_11 = Temporal.Instant.from('2026-11-13T00:00:00Z');

type AuditEntry = Parameters<AuditWriter['record']>[1];

class Audit implements AuditWriter {
  readonly rows: (AuditEntry & { readonly market: string })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    this.rows.push({ ...entry, market: context.market.marketId });
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('security alerts in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const responders = new Set<string>([ALI, HASSAN, KAZEM]);
  const gate = createUseCaseGate(markets, {
    check: (context: CallContext, declaration: AccessDeclaration) => {
      const actor = context.actor;
      const rule = declaration.rule;
      let allowed = rule.kind === 'system' ? actor.kind === 'system' : true;
      if (rule.kind === 'permissions') {
        const account = actor.kind === 'authenticated' ? actor.accountId : null;
        allowed = rule.allOf.every((key) =>
          key === SECURITY_VIEW.key
            ? account !== null
            : key === SECURITY_RESPOND.key && account !== null && responders.has(account),
        );
      }
      return Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  });
  const admin = (accountId: Id<'Account'>, ctx = market) =>
    testCallContext(
      ctx,
      testAuthenticatedActor(ctx, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
    );
  const system = testCallContext(market, 'system');

  let clock: FixedClock;
  let feed: FakeEventFeed;
  let alerts: InMemorySecurityAlerts;
  let messenger: RecordingMessenger;
  let roster: StaticRoster;
  let audit: Audit;
  let deps: SecurityDependencies;
  let eventNo: number;
  const useCase = <U>(type: new (g: typeof gate, d: SecurityDependencies) => U) =>
    new type(gate, deps);

  const event = (
    type: string,
    fields: Partial<Omit<FakeEvent, 'type'>> & { minutesAgo?: number } = {},
  ) => {
    eventNo += 1;
    const { minutesAgo = 1, ...rest } = fields;
    feed.stored.push({
      market: market.marketId,
      id: id<'SecurityEvent'>(0x1000 + eventNo),
      type,
      targetId: null,
      ip: null,
      payload: {},
      occurredAt: clock.now().subtract({ seconds: Math.round(minutesAgo * 60) }),
      ...rest,
    });
  };
  const failedSignIns = (
    count: number,
    fields: Partial<FakeEvent> & { minutesAgo?: number } = {},
  ) => {
    for (let index = 0; index < count; index += 1) {
      event('identity.sign-in.failed', {
        targetId: VICTIM,
        ip: '203.0.113.7',
        payload: { population: 'seller', reason: 'credentials-invalid' },
        ...fields,
      });
    }
  };
  const evaluate = () => useCase(EvaluateSecurityRules).execute(system, {});
  const deliver = () => useCase(DeliverSecurityAlerts).execute(system, {});
  const ruleAlerts = (rule: string) => alerts.alerts.filter((alert) => alert.rule === rule);

  beforeEach(() => {
    clock = new FixedClock(FRIDAY_11);
    feed = new FakeEventFeed();
    alerts = new InMemorySecurityAlerts();
    messenger = new RecordingMessenger();
    roster = new StaticRoster(testRoster({ ali: ALI, hassan: HASSAN }));
    audit = new Audit();
    eventNo = 0;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      alerts,
      events: feed,
      roster,
      messenger,
      audit,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
  });

  describe('the evaluator', () => {
    it('opens one alert per account and per address past the threshold, in its Market only', async () => {
      failedSignIns(10);
      failedSignIns(9, { targetId: id<'Account'>(0xb2), ip: '198.51.100.9' });
      failedSignIns(12, { market: other.marketId, targetId: id<'Account'>(0xb3) });
      const result = await evaluate();
      expect(result).toEqual({ ok: true, value: { opened: 2, updated: 0, failedRules: 0 } });
      expect(ruleAlerts('sign-in-failures-account')).toEqual([
        expect.objectContaining({
          market: market.marketId,
          severity: 's2',
          state: 'open',
          keyType: 'account',
          keyValue: VICTIM,
          eventCount: 10,
          nextNotifyAt: FRIDAY_11,
        }),
      ]);
      expect(ruleAlerts('sign-in-failures-ip')).toEqual([
        expect.objectContaining({ keyType: 'ip', keyValue: '203.0.113.7', eventCount: 10 }),
      ]);
      expect(alerts.runs.get(market.marketId)).toEqual({ finishedAt: FRIDAY_11, opened: 2 });
    });

    it('opens every alert of a flood of addresses but pushes only the first few s2 alerts', async () => {
      for (let host = 1; host <= MAX_PUSHED_S2_PER_RULE_RUN + 3; host += 1) {
        failedSignIns(10, { targetId: null, ip: `2001:db8::${host}` });
      }
      await evaluate();
      const flood = ruleAlerts('sign-in-failures-ip');
      expect(flood).toHaveLength(MAX_PUSHED_S2_PER_RULE_RUN + 3);
      expect(flood.filter((alert) => alert.nextNotifyAt !== null)).toHaveLength(
        MAX_PUSHED_S2_PER_RULE_RUN,
      );
    });

    it('ignores events outside the window', async () => {
      failedSignIns(10, { minutesAgo: 6 });
      await evaluate();
      expect(alerts.alerts).toEqual([]);
    });

    it('raises the live alert of a key instead of opening another', async () => {
      failedSignIns(10);
      await evaluate();
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      failedSignIns(3, { minutesAgo: 0.5 });
      expect((await evaluate()).ok).toBe(true);
      const [alert] = ruleAlerts('sign-in-failures-account');
      expect(ruleAlerts('sign-in-failures-account')).toHaveLength(1);
      expect(alert).toMatchObject({ eventCount: 13, version: 2 });
    });

    it('does not reopen a resolved alert on the events it already covered, only on new ones', async () => {
      failedSignIns(10);
      await evaluate();
      const [first] = ruleAlerts('sign-in-failures-account');
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const resolved = await useCase(ResolveSecurityAlert).execute(admin(KAZEM), {
        alertId: first!.id,
        expectedVersion: first!.version,
        resolution: 'false-positive',
        note: 'Seller mistyped the password.',
      });
      expect(resolved.ok).toBe(true);
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await evaluate();
      expect(ruleAlerts('sign-in-failures-account')).toHaveLength(1);
      failedSignIns(10, { minutesAgo: 0.5 });
      await evaluate();
      const after = ruleAlerts('sign-in-failures-account');
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ state: 'open', eventCount: 10 });
    });

    it('opens an s1 alert when an admin signs in after three failed attempts', async () => {
      const admin1 = id<'Account'>(0xc1);
      for (const minutesAgo of [9, 8, 7]) {
        event('identity.sign-in.failed', {
          targetId: admin1,
          payload: { population: 'admin', reason: 'credentials-invalid' },
          minutesAgo,
        });
      }
      event('identity.sign-in.succeeded', {
        targetId: admin1,
        payload: { population: 'admin', sessionId: id(0xd1) },
        minutesAgo: 2,
      });
      // A seller with the same pattern is not this rule's.
      for (const minutesAgo of [9, 8, 7]) {
        event('identity.sign-in.failed', {
          targetId: VICTIM,
          payload: { population: 'seller', reason: 'credentials-invalid' },
          minutesAgo,
        });
      }
      event('identity.sign-in.succeeded', {
        targetId: VICTIM,
        payload: { population: 'seller', sessionId: id(0xd2) },
        minutesAgo: 2,
      });
      await evaluate();
      expect(ruleAlerts('admin-sign-in-after-failures')).toEqual([
        expect.objectContaining({ severity: 's1', keyType: 'event', eventCount: 4 }),
      ]);
    });

    it('opens one alert per event for each-event rules, and a burst rule per Market', async () => {
      event('payments.transfer.alert', { payload: { kind: 'fence-breached' } });
      event('commission-payouts.payout.alert', { payload: { reason: 'zone-missing' } });
      for (let index = 0; index < 3; index += 1) {
        event('payments.payout-change.recorded', { minutesAgo: 10 + index });
      }
      await evaluate();
      expect(ruleAlerts('money-movement-alert')).toHaveLength(2);
      expect(ruleAlerts('payout-account-changes-burst')).toEqual([
        expect.objectContaining({ severity: 's1', keyType: 'market', keyValue: market.marketId }),
      ]);
      await evaluate();
      expect(ruleAlerts('money-movement-alert')).toHaveLength(2);
    });

    it('logs a failing rule and runs the others', async () => {
      failedSignIns(10);
      const broken = { ...SECURITY_RULES[2]!, code: 'broken' } as (typeof SECURITY_RULES)[number];
      const failing: SecurityEventFeed = {
        groups: () => Promise.reject(new Error('down')),
        events: (m, q) => feed.events(m, q),
        count: (m, q) => feed.count(m, q),
      };
      deps = { ...deps, events: failing };
      const result = await evaluateRules(deps, system, [broken]);
      expect(result).toEqual({ ok: true, value: { opened: 0, updated: 0, failedRules: 1 } });
    });

    it('is a system use case only', async () => {
      const result = await useCase(EvaluateSecurityRules).execute(admin(ALI), {});
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('the delivery job', () => {
    const openS1 = async () => {
      for (let index = 0; index < 3; index += 1) {
        event('payments.payout-change.recorded', { minutesAgo: 10 + index });
      }
      await evaluate();
      return ruleAlerts('payout-account-changes-burst')[0]!;
    };

    it('escalates s1 every 10 minutes until someone acknowledges it', async () => {
      const alert = await openS1();
      expect(await deliver()).toEqual({ ok: true, value: { steps: 1, messages: 3, failed: 2 } });
      expect(messenger.sent).toEqual([
        expect.objectContaining({ to: 'hossein', channel: 'email', market: market.marketId }),
      ]);
      expect(messenger.sent[0]!.message.subject).toBe(
        '[S1] Security alert: Several seller payout accounts changed within an hour',
      );
      expect(messenger.sent[0]!.message.text).not.toContain(
        market.marketId === 'AU' ? '203.' : '203.',
      );
      expect(
        alerts.deliveries.map((row) => [row.step, row.recipient, row.channel, row.outcome]),
      ).toEqual([
        [1, 'hossein', 'sms', 'not-configured'],
        [1, 'hossein', 'call', 'not-configured'],
        [1, 'hossein', 'email', 'sent'],
      ]);
      // Nothing is due before 10 minutes.
      clock.advance(Temporal.Duration.from({ minutes: 9 }));
      expect((await deliver()).ok && messenger.sent).toHaveLength(1);
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      await deliver();
      // Mojtaba has no email: recorded, not sent.
      expect(
        alerts.deliveries.slice(3).map((row) => [row.step, row.recipient, row.outcome]),
      ).toEqual([
        [2, 'mojtaba', 'not-configured'],
        [2, 'mojtaba', 'not-configured'],
        [2, 'mojtaba', 'no-contact'],
      ]);
      const current = (await alerts.get(market, alert.id))!;
      const ack = await useCase(AcknowledgeSecurityAlert).execute(admin(KAZEM), {
        alertId: alert.id,
        expectedVersion: current.version,
      });
      expect(ack).toMatchObject({ ok: true, value: { state: 'acknowledged', nextNotifyAt: null } });
      clock.advance(Temporal.Duration.from({ minutes: 30 }));
      expect(await deliver()).toEqual({ ok: true, value: { steps: 0, messages: 0, failed: 0 } });
      expect(audit.rows).toEqual([
        expect.objectContaining({
          action: 'security.alert.acknowledged',
          targetId: alert.id,
          market: market.marketId,
        }),
      ]);
    });

    it('holds s2 out of hours and sends it at the next business start', async () => {
      clock.set(Temporal.Instant.from('2026-11-13T08:00:00Z')); // Friday 19:00
      failedSignIns(10);
      await evaluate();
      expect(await deliver()).toEqual({ ok: true, value: { steps: 0, messages: 0, failed: 0 } });
      const [alert] = ruleAlerts('sign-in-failures-account');
      expect(alert!.nextNotifyAt).toEqual(Temporal.Instant.from('2026-11-15T22:00:00Z'));
      clock.set(Temporal.Instant.from('2026-11-15T22:00:00Z')); // Monday 09:00; Mojtaba's week
      await deliver();
      expect(messenger.sent.map((row) => [row.to, row.channel]).sort()).toEqual([
        ['hassan', 'email'],
        ['hassan', 'email'],
      ]);
    });

    it('records every channel as not configured when no roster is set', async () => {
      roster.value = null;
      await openS1();
      expect(await deliver()).toEqual({ ok: true, value: { steps: 1, messages: 3, failed: 3 } });
      expect(alerts.deliveries.map((row) => [row.recipient, row.outcome])).toEqual([
        [NO_ROSTER_RECIPIENT, 'not-configured'],
        [NO_ROSTER_RECIPIENT, 'not-configured'],
        [NO_ROSTER_RECIPIENT, 'not-configured'],
      ]);
      clock.advance(Temporal.Duration.from({ hours: 1 }));
      expect((await deliver()).ok && alerts.deliveries).toHaveLength(3);
    });

    it('stops after the last escalation step', async () => {
      await openS1();
      for (let step = 0; step < 14; step += 1) {
        await deliver();
        clock.advance(Temporal.Duration.from({ minutes: 10 }));
      }
      expect(new Set(alerts.deliveries.map((row) => row.step)).size).toBe(12);
    });
  });

  describe('the digests', () => {
    it('sends the daily s3 digest once a day in business hours', async () => {
      for (let index = 0; index < 5; index += 1) {
        event('payments.webhook-signature.failed', {
          ip: '192.0.2.1',
          payload: { provider: 'stripe' },
        });
      }
      await evaluate();
      const send = () => useCase(SendSecurityDigests).execute(system, {});
      expect(await send()).toEqual({ ok: true, value: { sent: 1 } });
      expect(messenger.sent).toEqual([expect.objectContaining({ to: 'hassan', channel: 'email' })]);
      expect(messenger.sent[0]!.message.subject).toBe('Daily security digest: 1 new S3 alerts');
      clock.advance(Temporal.Duration.from({ hours: 1 }));
      expect(await send()).toEqual({ ok: true, value: { sent: 0 } });
      expect(alerts.digests).toEqual([
        expect.objectContaining({
          kind: 'daily',
          period: '2026-11-13',
          alerts: 1,
          outcome: 'sent',
        }),
      ]);
    });

    it('sends nothing out of hours or with no alert', async () => {
      const send = () => useCase(SendSecurityDigests).execute(system, {});
      expect(await send()).toEqual({ ok: true, value: { sent: 0 } });
      clock.set(Temporal.Instant.from('2026-11-14T00:00:00Z'));
      event('payments.webhook-signature.failed', { ip: '192.0.2.1' });
      expect(await send()).toEqual({ ok: true, value: { sent: 0 } });
    });
  });

  describe('responding', () => {
    const openS2 = async () => {
      failedSignIns(10);
      await evaluate();
      return ruleAlerts('sign-in-failures-account')[0]!;
    };

    it('lists alerts by severity with the address masked, and shows one in full', async () => {
      await openS2();
      for (let index = 0; index < 3; index += 1) {
        event('payments.payout-change.recorded', { minutesAgo: 10 + index });
      }
      await evaluate();
      const page = await useCase(ListSecurityAlerts).execute(admin(VIEWER), {});
      expect(page.ok && page.value.alerts.map((alert) => [alert.severity, alert.rule])).toEqual([
        ['s1', 'payout-account-changes-burst'],
        // Same severity and opening instant: the newer id first.
        ['s2', 'sign-in-failures-ip'],
        ['s2', 'sign-in-failures-account'],
      ]);
      const ip = page.ok ? page.value.alerts[1]! : null;
      expect(ip?.keyLabel).toBe('203.0.113.…');
      const detail = await useCase(ViewSecurityAlert).execute(admin(VIEWER), { alertId: ip!.id });
      expect(detail).toMatchObject({ ok: true, value: { keyValue: '203.0.113.7' } });
      const filtered = await useCase(ListSecurityAlerts).execute(admin(VIEWER), {
        severity: 's2',
        limit: '1',
      });
      expect(filtered.ok && filtered.value.alerts).toHaveLength(1);
      const next = filtered.ok ? filtered.value.next : null;
      const second = await useCase(ListSecurityAlerts).execute(admin(VIEWER), {
        severity: 's2',
        limit: '1',
        after: next,
      });
      expect(second.ok && second.value.alerts.map((alert) => alert.rule)).toEqual([
        'sign-in-failures-account',
      ]);
      expect(await useCase(ListSecurityAlerts).execute(admin(VIEWER), { state: 'closed' })).toEqual(
        {
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'state', code: 'value' }] },
        },
      );
    });

    it("never shows another Market's alert", async () => {
      const alert = await openS2();
      const elsewhere = await useCase(ViewSecurityAlert).execute(admin(ALI, other), {
        alertId: alert.id,
      });
      expect(elsewhere).toEqual({ ok: false, error: { code: 'security.alert-not-found' } });
    });

    it('needs security.alerts.respond to act and refuses a stale version', async () => {
      const alert = await openS2();
      expect(
        await useCase(AcknowledgeSecurityAlert).execute(admin(VIEWER), {
          alertId: alert.id,
          expectedVersion: 1,
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await useCase(AcknowledgeSecurityAlert).execute(admin(KAZEM), {
          alertId: alert.id,
          expectedVersion: 7,
        }),
      ).toEqual({ ok: false, error: { code: 'security.conflict' } });
    });

    it('lets only Ali or Hassan resolve an s1 alert, with an outcome and a note', async () => {
      for (let index = 0; index < 3; index += 1) {
        event('payments.payout-change.recorded', { minutesAgo: 10 + index });
      }
      await evaluate();
      const alert = ruleAlerts('payout-account-changes-burst')[0]!;
      const input = {
        alertId: alert.id,
        expectedVersion: 1,
        resolution: 'contained',
        note: 'Payout accounts reverted.',
      };
      expect(await useCase(ResolveSecurityAlert).execute(admin(KAZEM), input)).toEqual({
        ok: false,
        error: { code: 'security.s1-resolver-only' },
      });
      expect(
        await useCase(ResolveSecurityAlert).execute(admin(HASSAN), { ...input, note: 'short' }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'note', code: 'length' }] },
      });
      const done = await useCase(ResolveSecurityAlert).execute(admin(HASSAN), input);
      expect(done).toMatchObject({
        ok: true,
        value: { state: 'resolved', resolvedBy: HASSAN, resolution: 'contained', version: 2 },
      });
      expect(audit.rows).toEqual([
        expect.objectContaining({
          action: 'security.alert.resolved',
          after: { severity: 's1', resolution: 'contained', version: 2 },
        }),
      ]);
      expect(
        await useCase(ResolveSecurityAlert).execute(admin(ALI), { ...input, expectedVersion: 2 }),
      ).toEqual({ ok: false, error: { code: 'security.alert-state' } });
    });

    it('resolves no s1 alert without a roster', async () => {
      roster.value = null;
      for (let index = 0; index < 3; index += 1) {
        event('payments.payout-change.recorded', { minutesAgo: 10 + index });
      }
      await evaluate();
      const alert = ruleAlerts('payout-account-changes-burst')[0]!;
      expect(
        await useCase(ResolveSecurityAlert).execute(admin(ALI), {
          alertId: alert.id,
          expectedVersion: 1,
          resolution: 'contained',
          note: 'Payout accounts reverted.',
        }),
      ).toEqual({ ok: false, error: { code: 'security.s1-resolver-only' } });
    });

    it('refuses an act in an acting-as session', async () => {
      const alert = await openS2();
      const acting = admin(KAZEM);
      const actor = { ...acting.actor, actingAs: { sellerId: id(0xee) } };
      const context = { ...acting, actor } as unknown as CallContext;
      const result = await useCase(AcknowledgeSecurityAlert).execute(context, {
        alertId: alert.id,
        expectedVersion: 1,
      });
      expect(result.ok).toBe(false);
    });

    it('shows the summary and the on-call view with names only', async () => {
      await openS2();
      await evaluate();
      const summary = await useCase(ViewSecuritySummary).execute(admin(VIEWER), {});
      expect(summary).toEqual({
        ok: true,
        value: {
          live: { s1: 0, s2: 2, s3: 0, s4: 0 },
          rulesLastRanAt: FRIDAY_11,
          onCall: { code: 'hossein', name: 'Hossein' },
        },
      });
      const onCall = await useCase(ViewOnCall).execute(admin(VIEWER), {});
      expect(onCall).toMatchObject({
        ok: true,
        value: {
          configured: true,
          zone: 'Australia/Sydney',
          businessHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
          escalation: [
            { code: 'hossein', name: 'Hossein' },
            { code: 'mojtaba', name: 'Mojtaba' },
            { code: 'kazem', name: 'Kazem' },
            { code: 'ali', name: 'Ali' },
          ],
          escalationIntervalMinutes: 10,
          escalationMaxSteps: 12,
        },
      });
      expect(JSON.stringify(onCall)).not.toMatch(/@|\+61/);
    });
  });
});

describe('an address key, masked', () => {
  it('keeps 24 bits of IPv4 and 48 bits of IPv6, never a host part', () => {
    expect(maskAddress('203.0.113.7')).toBe('203.0.113.…');
    expect(maskAddress('2001:db8::5')).toBe('2001:db8:0:…');
    expect(maskAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:…');
    expect(maskAddress('::ffff:192.0.2.44')).toBe('192.0.2.…');
    expect(maskAddress('not an address')).toBe('…');
  });
});
