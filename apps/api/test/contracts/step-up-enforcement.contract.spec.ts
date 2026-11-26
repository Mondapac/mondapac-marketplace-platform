import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ASSISTANT_STEP_UP from '../../src/modules/assistant/contracts/step-up';
import { BLOG_STEP_UP_ACTIONS } from '../../src/modules/blog/contracts/step-up';
import { CATALOG_STEP_UP_ACTIONS } from '../../src/modules/catalog/contracts/step-up';
import { COMMISSION_PAYOUTS_STEP_UP_ACTIONS } from '../../src/modules/commission-payouts/contracts/step-up';
import { CUSTOMERS_STEP_UP_ACTIONS } from '../../src/modules/customers/contracts/step-up';
import { IDENTITY_STEP_UP_ACTIONS } from '../../src/modules/identity/contracts/step-up';
import { ORDERING_STEP_UP_ACTIONS } from '../../src/modules/ordering/contracts/step-up';
import { PAYMENTS_STEP_UP_ACTIONS } from '../../src/modules/payments/contracts/step-up';
import { PRICING_STEP_UP_ACTIONS } from '../../src/modules/pricing/contracts/step-up';
import { PROMOTIONS_STEP_UP_ACTIONS } from '../../src/modules/promotions/contracts/step-up';
import { REVIEWS_STEP_UP_ACTIONS } from '../../src/modules/reviews/contracts/step-up';
import { SELLERS_STEP_UP_ACTIONS } from '../../src/modules/sellers/contracts/step-up';
import * as SETTINGS_STEP_UP from '../../src/modules/settings/contracts/step-up';
import { SYSTEM_REQUESTS_STEP_UP_ACTIONS } from '../../src/modules/system-requests/contracts/step-up';
import { WALLET_STEP_UP_ACTIONS } from '../../src/modules/wallet/contracts/step-up';

// Every step-up action is either guarded by `@RequiresStepUp` on a route, or listed here with the
// use case that spends a code in the request itself. A typo in a decorator key would otherwise
// fail closed (503) only at request time.
const ENFORCED_INSIDE_THE_FLOW = [
  'identity.second-factor.manage', // second-factor remove and recovery-codes use cases
  'payments.payout-account.change', // the payout-account flow asks for a code in its request
  'blog.post.self-approve', // approvePost spends the code only when the approver wrote or sent the post
  'promotions.platform-funding.approve', // the create, edit and budget use cases spend a code only above the Market step-up amount
  'system-requests.request.decide-high', // approve, reject and withdraw spend a code only for a high-risk request
  // AI Gateway (design section 8): each spends a code in its use case's unit, only for a change
  // that allows more AI (or, for the models and a revert, for every change that saves).
  'settings.ai-gateway-limits.raise', // ChangeAiGatewayLimits: raising or lifting a cap
  'settings.ai-gateway-emergency-stop.resume', // ChangeAiGatewayEmergencyStop: the stop switched off
  'settings.ai-models.change', // ChangeAiModels: every change that saves something
  'settings.ai-in-house.raise', // ChangeAiInHouse: a change that sends more to the in-house model (G6b)
  'settings.ai-capability.resume', // ChangeAiCapabilities and ChangeAiSetting: a capability switched on (G4d3)
  'settings.ai-settings.revert', // RevertAiGatewaySetting and RevertAiModelsSetting: every panel revert (G4d3)
  'assistant.settings.resume', // setAssistantSettings: the assistant switched on (G4d3)
];

/**
 * The step-up constants a decorator may name instead of a literal key (settings' controller uses
 * them): each exported string of these contracts files, by its name.
 */
const KEY_CONSTANTS: ReadonlyMap<string, string> = new Map(
  [ASSISTANT_STEP_UP, SETTINGS_STEP_UP].flatMap((namespace) =>
    Object.entries(namespace as Readonly<Record<string, unknown>>).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value] as const] : [],
    ),
  ),
);

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
    ...ASSISTANT_STEP_UP.ASSISTANT_STEP_UP_ACTIONS,
    ...BLOG_STEP_UP_ACTIONS,
    ...CATALOG_STEP_UP_ACTIONS,
    ...COMMISSION_PAYOUTS_STEP_UP_ACTIONS,
    ...CUSTOMERS_STEP_UP_ACTIONS,
    ...IDENTITY_STEP_UP_ACTIONS,
    ...ORDERING_STEP_UP_ACTIONS,
    ...PAYMENTS_STEP_UP_ACTIONS,
    ...PRICING_STEP_UP_ACTIONS,
    ...PROMOTIONS_STEP_UP_ACTIONS,
    ...REVIEWS_STEP_UP_ACTIONS,
    ...SELLERS_STEP_UP_ACTIONS,
    ...SETTINGS_STEP_UP.SETTINGS_STEP_UP_ACTIONS,
    ...SYSTEM_REQUESTS_STEP_UP_ACTIONS,
    ...WALLET_STEP_UP_ACTIONS,
  ].map((action) => action.key);
  const used = new Set(
    controllerFiles(sourceRoot).flatMap((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /@RequiresStepUp\((?:'([^']+)'|([A-Z][A-Z0-9_]*))\)/g,
        ),
      ].flatMap((m) => {
        // A constant of a contracts file not listed in KEY_CONSTANTS is not resolved here.
        const key = m[1] ?? KEY_CONSTANTS.get(m[2]!);
        return key === undefined ? [] : [key];
      }),
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
