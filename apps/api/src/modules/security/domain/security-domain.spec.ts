import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Temporal } from '@mondapac/shared-kernel';
import {
  AUDITED_SECURITY_ACTIONS,
  RECORDED_SECURITY_EVENTS,
} from '../../../platform/security-events/security-event-catalogue';
import { testRoster } from '../application/testing/in-memory-security';
import { acknowledgeAlert, normaliseNote, resolveAlert, type SecurityAlert } from './alert';
import { planDelivery, S1_MAX_STEPS } from './delivery';
import {
  escalationChain,
  isBusinessTime,
  localDate,
  localIsoWeek,
  nextBusinessStart,
  onCallAt,
  weekStartAt,
} from './roster';
import { SECURITY_RULES } from './rules';

// The pure rules of SOC package 2: the rule catalogue, the rotation and business hours in the
// roster's zone (across a daylight-saving change), the delivery plan by severity with the s1
// escalation, and the alert's transitions.

const RULES_SNAPSHOT = path.join(
  __dirname,
  '../../../../test/contracts/security-rules.snapshot.json',
);
const at = (iso: string) => Temporal.Instant.from(iso);
const roster = testRoster({
  ali: '01990000-0000-7000-8000-0000000000a1',
  hassan: '01990000-0000-7000-8000-0000000000a2',
});
// Friday 13 November 2026, 11:00 in Sydney (UTC+11): business hours, week 2 of the rotation.
const FRIDAY_11 = at('2026-11-13T00:00:00Z');

describe('the rule catalogue', () => {
  it('names only types of the closed security event catalogue', () => {
    const known = new Set([...RECORDED_SECURITY_EVENTS.keys(), ...AUDITED_SECURITY_ACTIONS.keys()]);
    for (const rule of SECURITY_RULES) {
      const types =
        rule.kind === 'success-after-failures'
          ? [rule.success.type, ...rule.failures.types]
          : rule.types;
      for (const type of types) expect([rule.code, known.has(type)]).toEqual([rule.code, true]);
    }
  });

  it('has unique kebab-case codes and positive thresholds and windows', () => {
    const codes = SECURITY_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const rule of SECURITY_RULES) {
      expect(rule.code).toMatch(/^[a-z][a-z0-9-]{1,63}$/);
      if (rule.kind !== 'each') expect(rule.threshold).toBeGreaterThanOrEqual(1);
      const window = rule.kind === 'threshold' ? rule.window : rule.lookback;
      expect(window.total({ unit: 'minutes' })).toBeGreaterThanOrEqual(5);
    }
  });

  it('matches the snapshot reviewed by the security-tester', () => {
    // Regenerate with SECURITY_RULES_SNAPSHOT=write; security-tester reads every change.
    const described = SECURITY_RULES.map((rule) => ({
      ...rule,
      ...('window' in rule ? { window: rule.window.toString() } : {}),
      ...('lookback' in rule ? { lookback: rule.lookback.toString() } : {}),
    }));
    const canonical = JSON.parse(JSON.stringify(described)) as unknown;
    if (process.env.SECURITY_RULES_SNAPSHOT === 'write') {
      writeFileSync(RULES_SNAPSHOT, `${JSON.stringify(canonical, null, 2)}\n`);
    }
    expect(canonical).toEqual(JSON.parse(readFileSync(RULES_SNAPSHOT, 'utf8')));
  });
});

describe('the on-call roster', () => {
  it('rotates weekly at the local handover time', () => {
    expect(onCallAt(roster, FRIDAY_11)).toBe('hossein');
    // Monday 9 November, 08:59 and 09:00 in Sydney.
    expect(onCallAt(roster, at('2026-11-08T21:59:00Z'))).toBe('kazem');
    expect(onCallAt(roster, at('2026-11-08T22:00:00Z'))).toBe('hossein');
    expect(onCallAt(roster, FRIDAY_11, 1)).toBe('mojtaba');
    expect(onCallAt(roster, FRIDAY_11, 2)).toBe('kazem');
    expect(weekStartAt(roster, FRIDAY_11)).toEqual(at('2026-11-08T22:00:00Z'));
  });

  it('counts back before the first week', () => {
    expect(onCallAt(roster, at('2026-10-30T00:00:00Z'))).toBe('mojtaba');
    // Monday 26 October, 08:00 (two weeks back) and 10:00 (one week back) in Sydney.
    expect(onCallAt(roster, at('2026-10-25T21:00:00Z'))).toBe('hossein');
    expect(onCallAt(roster, at('2026-10-25T23:00:00Z'))).toBe('mojtaba');
  });

  it('keeps the handover at 09:00 local across the daylight-saving change', () => {
    // Sydney moves to UTC+11 on Sunday 4 October 2026.
    const early = { ...roster, rotationStart: Temporal.PlainDateTime.from('2026-09-28T09:00') };
    expect(onCallAt(early, at('2026-10-04T22:59:00Z'))).toBe('hossein');
    expect(onCallAt(early, at('2026-10-04T21:59:00Z'))).toBe('kazem');
    expect(onCallAt(early, at('2026-10-04T22:00:00Z'))).toBe('hossein');
  });

  it('escalates through the rotation from the member on call, then the incident commander', () => {
    expect(escalationChain(roster, FRIDAY_11)).toEqual(['hossein', 'mojtaba', 'kazem', 'ali']);
  });

  it('reads business hours in the roster zone', () => {
    expect(isBusinessTime(roster.hours, FRIDAY_11)).toBe(true);
    expect(isBusinessTime(roster.hours, at('2026-11-13T07:00:00Z'))).toBe(false); // 18:00
    expect(isBusinessTime(roster.hours, at('2026-11-12T22:00:00Z'))).toBe(true); // 09:00
    expect(isBusinessTime(roster.hours, at('2026-11-14T00:00:00Z'))).toBe(false); // Saturday
    expect(nextBusinessStart(roster.hours, FRIDAY_11)).toEqual(FRIDAY_11);
    // Friday 19:00 -> Monday 09:00.
    expect(nextBusinessStart(roster.hours, at('2026-11-13T08:00:00Z'))).toEqual(
      at('2026-11-15T22:00:00Z'),
    );
    // Saturday 3 October (UTC+10) -> Monday 5 October 09:00 (UTC+11).
    expect(nextBusinessStart(roster.hours, at('2026-10-03T00:00:00Z'))).toEqual(
      at('2026-10-04T22:00:00Z'),
    );
  });

  it('names the digest periods in the roster zone', () => {
    expect(localDate(roster.hours, at('2026-11-13T20:00:00Z'))).toBe('2026-11-14');
    expect(localIsoWeek(roster.hours, FRIDAY_11)).toBe('2026-W46');
  });
});

describe('the delivery plan', () => {
  it('sends s1 by SMS, call and email, one more person every 10 minutes, at most 12 steps', () => {
    const first = planDelivery('s1', 0, roster, FRIDAY_11);
    expect(first.messages).toEqual([
      { recipient: 'hossein', channel: 'sms' },
      { recipient: 'hossein', channel: 'call' },
      { recipient: 'hossein', channel: 'email' },
    ]);
    expect(first.nextStep).toBe(1);
    expect(first.nextNotifyAt).toEqual(FRIDAY_11.add({ minutes: 10 }));
    expect(planDelivery('s1', 3, roster, FRIDAY_11).messages[0]!.recipient).toBe('ali');
    expect(planDelivery('s1', 4, roster, FRIDAY_11).messages[0]!.recipient).toBe('hossein');
    expect(planDelivery('s1', S1_MAX_STEPS - 1, roster, FRIDAY_11).nextNotifyAt).toBeNull();
    expect(planDelivery('s1', S1_MAX_STEPS, roster, FRIDAY_11)).toEqual({
      messages: [],
      nextStep: S1_MAX_STEPS,
      nextNotifyAt: null,
    });
  });

  it('sends s1 at night too', () => {
    expect(planDelivery('s1', 0, roster, at('2026-11-14T15:00:00Z')).messages).toHaveLength(3);
  });

  it('sends s2 once by email and team chat to the member on call and the owner, in hours', () => {
    const plan = planDelivery('s2', 0, roster, FRIDAY_11);
    expect(plan.messages).toEqual([
      { recipient: 'hossein', channel: 'email' },
      { recipient: 'hossein', channel: 'team-chat' },
      { recipient: 'hassan', channel: 'email' },
      { recipient: 'hassan', channel: 'team-chat' },
    ]);
    expect(plan).toMatchObject({ nextStep: 1, nextNotifyAt: null });
    expect(planDelivery('s2', 1, roster, FRIDAY_11).messages).toEqual([]);
  });

  it('holds s2 out of hours until the next business start', () => {
    expect(planDelivery('s2', 0, roster, at('2026-11-13T08:00:00Z'))).toEqual({
      messages: [],
      nextStep: 0,
      nextNotifyAt: at('2026-11-15T22:00:00Z'),
    });
  });

  it('pushes nothing for s3 and s4 (digests)', () => {
    for (const severity of ['s3', 's4'] as const) {
      expect(planDelivery(severity, 0, roster, FRIDAY_11)).toEqual({
        messages: [],
        nextStep: 0,
        nextNotifyAt: null,
      });
    }
  });
});

describe('an alert', () => {
  const alert = (severity: SecurityAlert['severity']): SecurityAlert => ({
    id: '01990000-0000-7000-8000-000000000001',
    rule: 'sign-in-failures-account',
    severity,
    state: 'open',
    keyType: 'account',
    keyValue: '01990000-0000-7000-8000-000000000002',
    eventCount: 10,
    firstEventAt: FRIDAY_11,
    lastEventAt: FRIDAY_11,
    openedAt: FRIDAY_11,
    notifyStep: 1,
    nextNotifyAt: FRIDAY_11.add({ minutes: 10 }),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    resolutionNote: null,
    version: 3,
  });
  const by = '01990000-0000-7000-8000-0000000000b1';
  const resolution = {
    at: FRIDAY_11,
    resolution: 'contained' as const,
    note: 'Locked the account.',
  };

  it('is acknowledged once, which stops its escalation', () => {
    const next = acknowledgeAlert(alert('s1'), by, FRIDAY_11);
    expect(next).toMatchObject({ state: 'acknowledged', nextNotifyAt: null, version: 4 });
    expect(acknowledgeAlert(next as SecurityAlert, by, FRIDAY_11)).toBe('security.alert-state');
  });

  it('is resolved at s1 only by the incident commander or the security owner', () => {
    const resolvers = [roster.members[3]!.accountId!, roster.members[4]!.accountId!];
    expect(resolveAlert(alert('s1'), { ...resolution, by, s1Resolvers: resolvers })).toBe(
      'security.s1-resolver-only',
    );
    expect(
      resolveAlert(alert('s1'), { ...resolution, by: resolvers[0]!, s1Resolvers: resolvers }),
    ).toMatchObject({ state: 'resolved', resolvedBy: resolvers[0], version: 4 });
    expect(resolveAlert(alert('s2'), { ...resolution, by, s1Resolvers: [] })).toMatchObject({
      state: 'resolved',
    });
  });

  it('is never changed once resolved', () => {
    const done = resolveAlert(alert('s2'), { ...resolution, by, s1Resolvers: [] }) as SecurityAlert;
    expect(resolveAlert(done, { ...resolution, by, s1Resolvers: [] })).toBe('security.alert-state');
    expect(acknowledgeAlert(done, by, FRIDAY_11)).toBe('security.alert-state');
  });

  it('takes a note of 10 to 1000 characters without control characters', () => {
    expect(normaliseNote('  Locked the account.  ')).toBe('Locked the account.');
    expect(normaliseNote('too short')).toBeNull();
    expect(normaliseNote('x'.repeat(1001))).toBeNull();
    expect(normaliseNote('line one\nline two')).toBe('line one\nline two');
    expect(normaliseNote('forged\u001b[2Jline')).toBeNull();
    expect(normaliseNote(42)).toBeNull();
  });
});
