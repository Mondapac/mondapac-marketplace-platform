// The buyer assistant's real-model evaluation (test/eval/, ADR-0019 decision 9). It calls the
// provider, so it is never part of `pnpm test` or `pnpm verify` (those match *.spec.ts only): run
// it on demand with `pnpm --filter @mondapac/api eval:assistant`, ASSISTANT_MODEL_API_KEY and
// ASSISTANT_EVAL_FAMILY. One case at a time, so the provider sees no burst.
const base = require('./jest.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testRegex: 'test/eval/.*\\.eval\\.ts$',
  testTimeout: 120_000,
  maxWorkers: 1,
};
