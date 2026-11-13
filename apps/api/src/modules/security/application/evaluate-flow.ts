import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { isPushed } from '../domain/delivery';
import {
  horizonOf,
  keyTypeOf,
  SECURITY_RULES,
  type AlertKeyType,
  type SecurityRule,
} from '../domain/rules';
import type { SecurityDependencies } from './security-dependencies';

// The rule evaluator (SOC package 2; docs/design/data/security.md 4.1). Every minute, per Market:
// each rule reads the security events of its window through the platform feed and opens an alert
// per key that matches, or raises the count of the key's live alert. A key whose last alert was
// resolved inside the window counts only the events after the resolution, so resolving an alert
// does not reopen it at the next run. Each rule runs in its own unit; a failing rule is logged and
// the others still run.

const logger = new Logger('SecurityRuleEvaluator');

/** The most keys one rule handles per run (bounded work, P 7); the rest wait for the next run. */
export const MAX_MATCHES_PER_RULE = 200;

/** One key a rule matched in this run. */
interface Match {
  readonly keyValue: string;
  readonly eventCount: number;
  readonly firstEventAt: Temporal.Instant;
  readonly lastEventAt: Temporal.Instant;
}

export interface EvaluationReport {
  readonly opened: number;
  readonly updated: number;
  readonly failedRules: number;
}

async function matchesOf(
  deps: SecurityDependencies,
  market: MarketContext,
  rule: SecurityRule,
  now: Temporal.Instant,
  since: Temporal.Instant,
): Promise<readonly Match[]> {
  switch (rule.kind) {
    case 'threshold': {
      const groups = await deps.events.groups(market, {
        types: rule.types,
        payloadEquals: rule.payloadEquals,
        since,
        until: now,
        groupBy: rule.groupBy,
        minCount: rule.threshold,
        limit: MAX_MATCHES_PER_RULE,
      });
      return groups.map((group) => ({
        keyValue: group.key,
        eventCount: group.count,
        firstEventAt: group.firstAt,
        lastEventAt: group.lastAt,
      }));
    }
    case 'each': {
      const events = await deps.events.events(market, {
        types: rule.types,
        payloadEquals: rule.payloadEquals,
        since,
        until: now,
        limit: MAX_MATCHES_PER_RULE,
      });
      return events.map((event) => ({
        keyValue: event.id,
        eventCount: 1,
        firstEventAt: event.occurredAt,
        lastEventAt: event.occurredAt,
      }));
    }
    case 'success-after-failures': {
      const successes = await deps.events.events(market, {
        types: [rule.success.type],
        payloadEquals: rule.success.payloadEquals,
        since,
        until: now,
        limit: MAX_MATCHES_PER_RULE,
      });
      const matches: Match[] = [];
      for (const success of successes) {
        if (success.targetId === null) continue;
        const failures = await deps.events.count(market, {
          types: rule.failures.types,
          payloadEquals: rule.failures.payloadEquals,
          since: success.occurredAt.subtract(rule.window),
          until: success.occurredAt,
          key: { kind: 'account', value: success.targetId },
        });
        if (failures >= rule.threshold) {
          matches.push({
            keyValue: success.id,
            eventCount: failures + 1,
            firstEventAt: success.occurredAt,
            lastEventAt: success.occurredAt,
          });
        }
      }
      return matches;
    }
  }
}

/**
 * For a key whose last alert was resolved inside the window: the events after the resolution
 * only. An `event` key is one event: it matched before the resolution, so it does not reopen.
 */
async function afterResolution(
  deps: SecurityDependencies,
  market: MarketContext,
  rule: SecurityRule,
  keyType: AlertKeyType,
  match: Match,
  resolvedAt: Temporal.Instant,
  now: Temporal.Instant,
): Promise<Match | null> {
  if (Temporal.Instant.compare(match.lastEventAt, resolvedAt) < 0) return null;
  if (rule.kind !== 'threshold' || keyType === 'event') {
    // An event that occurred at or after the resolution is a new event: open for it.
    return match;
  }
  if (Temporal.Instant.compare(resolvedAt, now) >= 0) return null;
  const count = await deps.events.count(market, {
    types: rule.types,
    payloadEquals: rule.payloadEquals,
    since: resolvedAt,
    until: now,
    key: keyType === 'market' ? null : { kind: keyType, value: match.keyValue },
  });
  if (count < rule.threshold) return null;
  return {
    ...match,
    eventCount: count,
    firstEventAt:
      Temporal.Instant.compare(match.firstEventAt, resolvedAt) < 0
        ? resolvedAt
        : match.firstEventAt,
  };
}

/** The most s2 alerts one rule pushes (email and team chat) in one run. */
export const MAX_PUSHED_S2_PER_RULE_RUN = 5;

async function evaluateRule(
  deps: SecurityDependencies,
  market: MarketContext,
  rule: SecurityRule,
  now: Temporal.Instant,
): Promise<{ opened: number; updated: number }> {
  const keyType = keyTypeOf(rule);
  const since = now.subtract(horizonOf(rule));
  const result = await deps.unitOfWork.run(market, async () => {
    let opened = 0;
    let updated = 0;
    let pushed = 0;
    for (const found of await matchesOf(deps, market, rule, now, since)) {
      const live = await deps.alerts.findLive(market, rule.code, keyType, found.keyValue);
      if (live !== null) {
        if (await deps.alerts.touch(market, live, found)) updated += 1;
        continue;
      }
      const resolvedAt = await deps.alerts.lastResolvedAt(
        market,
        rule.code,
        keyType,
        found.keyValue,
      );
      const match =
        resolvedAt !== null && Temporal.Instant.compare(resolvedAt, found.firstEventAt) > 0
          ? await afterResolution(deps, market, rule, keyType, found, resolvedAt, now)
          : found;
      if (match === null) continue;
      // A flood of keys (many addresses at once) opens every alert but pushes only the first few
      // s2 alerts of a run; the rest wait in the centre and the digest. s1 is never held back.
      const push =
        isPushed(rule.severity) && (rule.severity === 's1' || pushed < MAX_PUSHED_S2_PER_RULE_RUN);
      if (isPushed(rule.severity) && !push && pushed === MAX_PUSHED_S2_PER_RULE_RUN) {
        pushed += 1;
        logger.warn({
          msg: 'security.rule-push-capped',
          rule: rule.code,
          marketId: market.marketId,
        });
      }
      const created = await deps.alerts.open(market, {
        id: deps.ids.next<'SecurityAlert'>(),
        rule: rule.code,
        severity: rule.severity,
        keyType,
        keyValue: match.keyValue,
        eventCount: match.eventCount,
        firstEventAt: match.firstEventAt,
        lastEventAt: match.lastEventAt,
        openedAt: now,
        nextNotifyAt: push ? now : null,
      });
      if (created) opened += 1;
      if (created && push) pushed += 1;
    }
    return ok({ opened, updated });
  });
  return result.ok ? result.value : { opened: 0, updated: 0 };
}

/** One run of every rule for the context's Market (rule `system`). */
export async function evaluateRules(
  deps: SecurityDependencies,
  context: CallContext,
  rules: readonly SecurityRule[] = SECURITY_RULES,
): Promise<Result<EvaluationReport, never>> {
  const now = deps.clock.now();
  let opened = 0;
  let updated = 0;
  let failedRules = 0;
  for (const rule of rules) {
    try {
      const report = await evaluateRule(deps, context.market, rule, now);
      opened += report.opened;
      updated += report.updated;
    } catch (error) {
      failedRules += 1;
      // The rule's code and the error's name only: a database message can carry values.
      logger.error({
        msg: 'security.rule-failed',
        rule: rule.code,
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
    }
  }
  await deps.unitOfWork.run(context.market, async () => {
    await deps.alerts.recordEvaluatorRun(context.market, { finishedAt: deps.clock.now(), opened });
    return ok(undefined);
  });
  return ok({ opened, updated, failedRules });
}
