import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { testInHouseRoute, testRoute } from '../../../../test/support/ai-routes';
import type { AppConfig } from '../../config/app-config';
import { ModelGateway } from '../model-gateway';
import type { ModelCredentials, ModelProvider } from '../model-provider';
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_FRESH_FOR,
  HEALTH_REFRESH_AFTER,
  InHouseHealth,
} from './in-house-health';

const AU = 'AU' as MarketId;
const ZZ = 'ZZ' as MarketId;
const ROW = testInHouseRoute('mondapac-intelligence');
const KEY = 'in-house-test-canary-key-0123456789abcdef';

const configOf = (inHouseApiKeys: Record<string, string>, aiKillSwitch = false) =>
  ({
    assistantModels: { apiKeys: {}, bedrockApiKeys: {}, inHouseApiKeys, removedVariables: [] },
    aiKillSwitch,
  }) as unknown as AppConfig;

/** A provider whose health answers are scripted, one per check, then the last one again. */
class HealthScript implements ModelProvider {
  readonly checks: ModelCredentials[] = [];
  constructor(private readonly answers: (() => Promise<boolean>)[]) {}
  call(): never {
    throw new Error('a health check never calls the model');
  }
  health(credentials: ModelCredentials): Promise<boolean> {
    this.checks.push(credentials);
    const answer = this.answers[Math.min(this.checks.length - 1, this.answers.length - 1)]!;
    return answer();
  }
}

const yes = () => Promise.resolve(true);
const no = () => Promise.resolve(false);

function healthOf(provider: ModelProvider, config = configOf({ AU: KEY, ZZ: KEY })) {
  const clock = new FixedClock(Temporal.Instant.from('2026-11-27T04:00:00Z'));
  const health = new InHouseHealth(new ModelGateway(config, provider), clock);
  return { clock, health };
}

describe('InHouseHealth (G6d1, FE-20261126-ai-gateway-in-house-health-check)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('is not healthy before a check answered, then healthy once one said so', async () => {
    const provider = new HealthScript([yes]);
    const { health } = healthOf(provider);

    expect(health.healthy(AU, ROW)).toBe(false);
    await health.settled();
    expect(health.healthy(AU, ROW)).toBe(true);
    expect(provider.checks).toHaveLength(1);
    expect(provider.checks[0]).toEqual(
      expect.objectContaining({ apiKey: KEY, model: ROW.model, endpoint: ROW.endpoint }),
    );
  });

  it('runs one check at a time per Market and row, never one per call', async () => {
    const provider = new HealthScript([yes]);
    const { health } = healthOf(provider);
    health.healthy(AU, ROW);
    health.healthy(AU, ROW);
    health.healthy(AU, ROW);
    await health.settled();
    expect(provider.checks).toHaveLength(1);
    // Each Market is checked with its own key, on its own.
    health.healthy(ZZ, ROW);
    await health.settled();
    expect(provider.checks).toHaveLength(2);
  });

  it('refreshes in the background from the refresh age, and is stale (not healthy) after the fresh age', async () => {
    let release: (healthy: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => (release = resolve));
    const provider = new HealthScript([yes, () => pending]);
    const { clock, health } = healthOf(provider);
    health.healthy(AU, ROW);
    await health.settled();

    clock.advance(HEALTH_REFRESH_AFTER.subtract(Temporal.Duration.from({ seconds: 1 })));
    expect(health.healthy(AU, ROW)).toBe(true);
    expect(provider.checks).toHaveLength(1);

    clock.advance(Temporal.Duration.from({ seconds: 1 }));
    // Still within the fresh age: healthy, and a refresh started (it never answers here).
    expect(health.healthy(AU, ROW)).toBe(true);
    expect(provider.checks).toHaveLength(2);

    clock.set(Temporal.Instant.from('2026-11-27T04:00:00Z').add(HEALTH_FRESH_FOR));
    expect(health.healthy(AU, ROW)).toBe(false);
    expect(provider.checks).toHaveLength(2);
    release(true);
    await health.settled();
  });

  it('turns unhealthy when a later check fails, and healthy again on the next good one', async () => {
    const provider = new HealthScript([yes, no, yes]);
    const { clock, health } = healthOf(provider);
    health.healthy(AU, ROW);
    await health.settled();
    clock.advance(HEALTH_REFRESH_AFTER);
    health.healthy(AU, ROW);
    await health.settled();
    expect(health.healthy(AU, ROW)).toBe(false);
    clock.advance(HEALTH_REFRESH_AFTER);
    health.healthy(AU, ROW);
    await health.settled();
    expect(health.healthy(AU, ROW)).toBe(true);
  });

  it('is not healthy on a check that throws or does not answer in time', async () => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    try {
      const hanging = new HealthScript([() => new Promise<boolean>(() => undefined)]);
      const { health } = healthOf(hanging);
      health.healthy(AU, ROW);
      jest.advanceTimersByTime(HEALTH_CHECK_TIMEOUT_MS);
      await health.settled();
      expect(health.healthy(AU, ROW)).toBe(false);

      const throwing = new HealthScript([() => Promise.reject(new Error('boom'))]);
      const other = healthOf(throwing).health;
      other.healthy(AU, ROW);
      await other.settled();
      expect(other.healthy(AU, ROW)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends no check without the Market key, under the kill switch, or for an external row', async () => {
    const provider = new HealthScript([yes]);
    const noKey = healthOf(provider, configOf({ ZZ: KEY })).health;
    noKey.healthy(AU, ROW);
    await noKey.settled();
    expect(noKey.healthy(AU, ROW)).toBe(false);

    const killed = healthOf(provider, configOf({ AU: KEY }, true)).health;
    killed.healthy(AU, ROW);
    await killed.settled();
    expect(killed.healthy(AU, ROW)).toBe(false);

    const external = healthOf(provider).health;
    external.healthy(AU, testRoute('model-fast'));
    await external.settled();
    expect(external.healthy(AU, testRoute('model-fast'))).toBe(false);
    expect(provider.checks).toHaveLength(0);
  });

  it('starts no check once the application is closing', async () => {
    const provider = new HealthScript([yes]);
    const { health } = healthOf(provider);
    await health.beforeApplicationShutdown();
    health.healthy(AU, ROW);
    await health.settled();
    expect(provider.checks).toHaveLength(0);
  });
});
