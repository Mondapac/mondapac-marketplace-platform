import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CATALOG_STEP_UP_ACTIONS } from '../../src/modules/catalog/contracts/step-up';
import { IDENTITY_STEP_UP_ACTIONS } from '../../src/modules/identity/contracts/step-up';
import { PAYMENTS_STEP_UP_ACTIONS } from '../../src/modules/payments/contracts/step-up';
import { PRICING_STEP_UP_ACTIONS } from '../../src/modules/pricing/contracts/step-up';
import { SELLERS_STEP_UP_ACTIONS } from '../../src/modules/sellers/contracts/step-up';

// Every step-up action is either guarded by `@RequiresStepUp` on a route, or listed here with the
// use case that spends a code in the request itself. A typo in a decorator key would otherwise
// fail closed (503) only at request time.
const ENFORCED_INSIDE_THE_FLOW = [
  'identity.second-factor.manage', // second-factor remove and recovery-codes use cases
  'payments.payout-account.change', // the payout-account flow asks for a code in its request
];

const sourceRoot = path.resolve(__dirname, '../../src');

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return full.endsWith('.controller.ts') ? [full] : [];
  });
}

describe('step-up enforcement contract', () => {
  const registered = [
    ...CATALOG_STEP_UP_ACTIONS,
    ...IDENTITY_STEP_UP_ACTIONS,
    ...PAYMENTS_STEP_UP_ACTIONS,
    ...PRICING_STEP_UP_ACTIONS,
    ...SELLERS_STEP_UP_ACTIONS,
  ].map((action) => action.key);
  const used = new Set(
    controllerFiles(sourceRoot).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/@RequiresStepUp\('([^']+)'\)/g)].map((m) => m[1]!),
    ),
  );

  it('every decorator key is a registered action', () => {
    expect([...used].filter((key) => !registered.includes(key))).toEqual([]);
  });

  it('every registered action is guarded by a route or listed as enforced in its flow', () => {
    expect(
      registered.filter((key) => !used.has(key) && !ENFORCED_INSIDE_THE_FLOW.includes(key)),
    ).toEqual([]);
  });
});
