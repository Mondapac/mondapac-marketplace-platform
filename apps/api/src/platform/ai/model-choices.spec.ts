import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import {
  passesFor,
  testRoute,
  testRouteCatalogue,
  testRouter,
} from '../../../test/support/ai-routes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import type { AppConfig } from '../config/app-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import type { MarketId } from '@mondapac/shared-kernel';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { AiModelChoices } from './model-choices';
import { ModelGateway } from './model-gateway';
import type { ModelProvider } from './model-provider';

// The External models tab's server checks (AI Gateway G4b; docs/design/domain/platform-ai.md
// sections 7 and 8) on the real router: a family enters a task type's list only when it is in the
// catalogue, once, and usable for every capability of that task type in the Market; a saver model
// also needs a list and is cheaper than model 1. Both Market fixtures.

const NOW = Temporal.Instant.from('2026-11-25T10:00:00Z');
const MARKETS = new MarketRegistry(
  new Map(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);
const base = {
  audience: 'admin',
  sellerScoped: false,
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;
const WRITER: CapabilitySpec = { id: 'alpha.writer', task: 'write', ...base };
const SECOND_WRITER: CapabilitySpec = { id: 'alpha.second-writer', task: 'write', ...base };
const CHAT: CapabilitySpec = { id: 'alpha.chat', task: 'chat', ...base };
const SPECS = [WRITER, SECOND_WRITER, CHAT];

const NO_PROVIDER: ModelProvider = {
  call: () => Promise.reject(new Error('no model is called by a check')),
};

/** Keys for the given Markets on the provider's own route. */
const configOf = (codes: readonly string[]) =>
  ({
    aiKillSwitch: false,
    assistantModels: {
      apiKeys: Object.fromEntries(codes.map((code) => [code, 'sk-test-canary-key-0001'])),
      models: { fast: {}, balanced: {} },
      bedrockApiKeys: {},
    },
  }) as unknown as AppConfig;

const CATALOGUE = testRouteCatalogue([
  testRoute('model-cheap', 'anthropic-api', { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 }),
  testRoute('model-old', 'anthropic-api', { retiresOn: '2026-11-01' }),
  testRoute('model-unchecked', 'anthropic-api', { dataTerms: null }),
  testRoute('model-us', 'anthropic-api', { region: 'us-east-1' }),
  testRoute('model-half', 'anthropic-api'),
]);

function choicesOf(
  options: {
    readonly specs?: readonly CapabilitySpec[];
    readonly keys?: readonly string[];
    readonly passes?: ReturnType<typeof passesFor>;
  } = {},
): AiModelChoices {
  const specs = options.specs ?? SPECS;
  const registry = new CapabilityRegistry();
  if (specs.length > 0) registry.register('alpha', specs);
  registry.seal();
  const models = new ModelGateway(configOf(options.keys ?? ['AU', 'ZZ']), NO_PROVIDER, CATALOGUE);
  const passes =
    options.passes ??
    passesFor(specs, [
      'model-fast',
      'model-balanced',
      'model-cheap',
      'model-old',
      'model-unchecked',
      'model-us',
    ]);
  return new AiModelChoices(
    testRouter(CATALOGUE, passes, models, MARKETS, new FixedClock(NOW)),
    registry,
  );
}

describe.each(['AU', 'ZZ'] as const)('AiModelChoices in market %s (G4b)', (code) => {
  const marketId = code as MarketId;

  it('takes up to 3 usable families once each, in any order', () => {
    expect(
      choicesOf().check(marketId, 'write', ['model-balanced', 'model-fast', 'model-cheap'], null),
    ).toEqual({ list: [null, null, null], saver: null });
    expect(choicesOf().check(marketId, 'write', [], null)).toEqual({ list: [], saver: null });
  });

  it('names why a family cannot be chosen', () => {
    const choices = choicesOf();
    expect(
      choices.check(marketId, 'write', ['model-none', 'model-old', 'model-unchecked'], null).list,
    ).toEqual(['unknown-model', 'retired', 'not-checked']);
    expect(choices.check(marketId, 'write', ['model-us'], null).list).toEqual(['region']);
    expect(choices.check(marketId, 'write', ['model-fast', 'model-fast'], null).list).toEqual([
      null,
      'duplicate',
    ]);
    expect(
      choices.check(
        marketId,
        'write',
        ['model-fast', 'model-balanced', 'model-cheap', 'model-half'],
        null,
      ).list,
    ).toEqual([null, null, null, 'too-many']);
  });

  it('refuses a family without a key in the Market', () => {
    expect(
      choicesOf({ keys: [code === 'AU' ? 'ZZ' : 'AU'] }).check(
        marketId,
        'write',
        ['model-cheap'],
        null,
      ).list,
    ).toEqual(['no-key']);
  });

  it('needs an evaluation pass for every capability of the task type, not just one', () => {
    const halfPasses = passesFor([WRITER], ['model-half']);
    const choices = choicesOf({ passes: halfPasses });
    expect(choices.check(marketId, 'write', ['model-half'], null).list).toEqual(['not-evaluated']);
    // The chat task type has its own capability, which has no pass either.
    expect(choices.check(marketId, 'chat', ['model-half'], null).list).toEqual(['not-evaluated']);
    // With no capability of the task type yet, every condition but the evaluation.
    expect(
      choicesOf({ specs: [], passes: halfPasses }).check(marketId, 'extract', ['model-half'], null)
        .list,
    ).toEqual([null]);
  });

  it('never takes a vision model (no route serves image input yet)', () => {
    expect(choicesOf({ specs: [] }).check(marketId, 'vision', ['model-fast'], null).list).toEqual([
      'task-unsupported',
    ]);
  });

  it('takes a saver model only after a list, usable and cheaper than model 1', () => {
    const choices = choicesOf();
    expect(choices.check(marketId, 'write', ['model-fast'], 'model-cheap').saver).toBeNull();
    expect(choices.check(marketId, 'write', [], 'model-cheap').saver).toBe('saver-without-list');
    expect(choices.check(marketId, 'write', ['model-fast'], 'model-balanced').saver).toBe(
      'saver-not-cheaper',
    );
    expect(choices.check(marketId, 'write', ['model-fast'], 'model-fast').saver).toBe(
      'saver-not-cheaper',
    );
    expect(choices.check(marketId, 'write', ['model-fast'], 'model-old').saver).toBe('retired');
  });

  it('lists every catalogue family per task type with why it cannot be chosen', () => {
    const options = choicesOf().options(marketId);
    expect(Object.keys(options)).toEqual(['chat', 'extract', 'write', 'vision']);
    expect(options.write).toEqual([
      { family: 'model-balanced', problem: null },
      { family: 'model-cheap', problem: null },
      { family: 'model-fast', problem: null },
      { family: 'model-half', problem: 'not-evaluated' },
      { family: 'model-old', problem: 'retired' },
      { family: 'model-unchecked', problem: 'not-checked' },
      { family: 'model-us', problem: 'region' },
    ]);
    expect(options.vision.every((option) => option.problem === 'task-unsupported')).toBe(true);
  });
});
