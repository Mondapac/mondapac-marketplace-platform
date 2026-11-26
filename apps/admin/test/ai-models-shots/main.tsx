import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { AiModelsPanel } from '../../src/ai-models/ai-models-panel.tsx';
import type { ModelsAnswer } from '../../src/ai-models/types.ts';

// Scenarios: `scorecard` (Evaluation tab with usage), `empty` (no calls yet), `failed` (the usage
// read failed), `preview` (the save preview with the monthly estimate).
const scenario = new URLSearchParams(window.location.search).get('s') ?? 'scorecard';
const family = (
  name: string,
  calls: number,
  failures: number,
  stoodIn: number,
  cost: number,
  p95: { bound: number; above: boolean } | null,
  passed: number,
) => ({
  family: name,
  provider: 'anthropic',
  calls,
  failures,
  stoodIn,
  costMicroUsd: cost,
  p95,
  evaluation: { passed, of: 3 },
});
const USAGE = {
  from: '2026-10-28',
  to: '2026-11-26',
  days: 30,
  families:
    scenario === 'empty'
      ? [
          family('claude-haiku-5-5', 0, 0, 0, 0, null, 0),
          family('claude-sonnet-5-5', 0, 0, 0, 0, null, 0),
        ]
      : [
          family('claude-haiku-5-5', 41_250, 412, 96, 30_937_500, { bound: 2000, above: false }, 3),
          family('claude-opus-5-5', 0, 0, 0, 0, null, 0),
          family('claude-sonnet-5-5', 3_120, 18, 401, 18_720_000, { bound: 4000, above: false }, 2),
        ],
  tasks: [
    {
      task: 'chat',
      calls: 38_000,
      inputTokens: 52_000_000,
      outputTokens: 7_600_000,
      costByFamily: [
        { family: 'claude-haiku-5-5', costMicroUsd: 90_000_000 },
        { family: 'claude-opus-5-5', costMicroUsd: null },
        { family: 'claude-sonnet-5-5', costMicroUsd: 270_000_000 },
      ],
    },
    {
      task: 'write',
      calls: 6_370,
      inputTokens: 9_100_000,
      outputTokens: 3_200_000,
      costByFamily: [
        { family: 'claude-haiku-5-5', costMicroUsd: 25_100_000 },
        { family: 'claude-opus-5-5', costMicroUsd: null },
        { family: 'claude-sonnet-5-5', costMicroUsd: 75_300_000 },
      ],
    },
    { task: 'extract', calls: 0, inputTokens: 0, outputTokens: 0, costByFamily: [] },
    { task: 'vision', calls: 0, inputTokens: 0, outputTokens: 0, costByFamily: [] },
  ],
};
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
globalThis.fetch = (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('ai-models/usage')) {
    return scenario === 'failed' ? json({ statusCode: 500, code: 'internal' }, 500) : json(USAGE);
  }
  if (url.includes('ai-models/evaluations')) return json({ runs: [], next: null });
  return json({});
};

const row = (code: string, value: string, version = 1) => ({
  code,
  value,
  version,
  updatedAt: null,
});
const option = (name: string, problem: string | null = null) => ({ family: name, problem });
const ANSWER: ModelsAnswer = {
  settings: [
    row('ai-models-chat', 'claude-haiku-5-5,claude-sonnet-5-5'),
    row('ai-models-write', 'claude-haiku-5-5'),
    row('ai-saver-percent', '80'),
  ],
  options: {
    chat: [
      option('claude-haiku-5-5'),
      option('claude-sonnet-5-5'),
      option('claude-opus-5-5', 'not-evaluated'),
    ],
    extract: [option('claude-haiku-5-5')],
    write: [
      option('claude-haiku-5-5'),
      option('claude-sonnet-5-5'),
      option('claude-opus-5-5', 'not-evaluated'),
    ],
    vision: [],
  },
};

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <div className="mx-auto max-w-6xl p-4">
      <AiModelsPanel initial={ANSWER} canManage csrfToken="tok" />
    </div>
  </NextIntlClientProvider>,
);
