import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { InHousePanel } from '../../src/ai-models/in-house-panel.tsx';

// Scenarios: `held` (Write rolled back on errors and still held off, Chat rolled back earlier and
// changed since), `none` (no rollback yet).
const scenario = new URLSearchParams(window.location.search).get('s') ?? 'held';
const row = (code: string, value: string, version = 1) => ({
  code,
  value,
  version,
  updatedAt: null,
});
const rollback = (task: string, reason: string, stage: string, heldOff: boolean) => ({
  task,
  family: 'mondapac-1',
  stage,
  reason,
  calls: 400,
  failures: reason === 'errors' ? 120 : 6,
  guardRejected: reason === 'guard' ? 64 : 3,
  errorsLimitPermille: 20,
  guardLimitPermille: 10,
  minSample: 200,
  rolledBackAt: '2026-11-27T10:00:00.000Z',
  heldOff,
});
const ANSWER = {
  settings: [
    row('ai-in-house-stage-write', 'percent', 3),
    row('ai-in-house-model-write', 'mondapac-1', 2),
    row('ai-in-house-rollout-write', '10', 1),
    row('ai-in-house-stage-chat', 'default', 3),
    row('ai-in-house-model-chat', 'mondapac-1', 2),
  ],
  options: {
    chat: [{ family: 'mondapac-1', problem: null }],
    extract: [],
    write: [{ family: 'mondapac-1', problem: null }],
    vision: [],
  },
  rollbacks:
    scenario === 'held'
      ? [rollback('chat', 'guard', 'default', false), rollback('write', 'errors', 'percent', true)]
      : [],
};
globalThis.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify(ANSWER), { headers: { 'content-type': 'application/json' } }),
  );

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <div className="mx-auto max-w-6xl p-4">
      <InHousePanel canManage csrfToken="tok" />
    </div>
  </NextIntlClientProvider>,
);
