// F-3 (handoff phase5-connected-accounts, gate before package 6c transfers): in Stripe test
// mode, the platform can create a connected account (Accounts v2, Express Dashboard, recipient
// configuration), open its onboarding page, and set its payout schedule to manual and back
// through the gateway the API ships (job payments.sync-payout-schedules), and Stripe reports the
// new interval when the account is read again. The account's controller settings are recorded
// too: they decide whether the seller can change the schedule from the Express Dashboard.
//
// Creates one throwaway test account and deletes it at the end. Needs the built API
// (pnpm build). Prints ids and results only, never the key.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test/f3-payout-schedule.mjs
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Report, stripe, stripeError, testKey } from './stripe-test-kit.mjs';

const require = createRequire(path.resolve('apps/api/package.json'));
const {
  STRIPE_V2_VERSION,
  StripeConnectGateway,
} = require('./dist/modules/payments/infrastructure/stripe-connect-gateway.js');

const key = testKey();
// The gateway's answers carry codes only; the last Stripe answer is kept to show Stripe's reason.
let lastAnswer = null;
const gateway = new StripeConnectGateway(key, async (url, init) => {
  const response = await fetch(url, init);
  const body = await response.json();
  lastAnswer = { status: response.status, body };
  return { status: response.status, json: async () => body };
});
const report = new Report('F-3: platform sets an Express payout schedule (Stripe test mode)');
const run = randomUUID();

// Created by the gateway the API ships (Accounts v2), as a seller's payout account is. The
// contact email is a reserved test address, not a person's.
const created = await gateway.createAccount({
  idempotencyKey: `f3-create-${run}`,
  country: 'AU',
  marketId: 'AU',
  sellerId: run,
  contactEmail: `f3-${run.slice(0, 8)}@example.com`,
});
const accountId = created.ok ? created.value.accountRef : null;

try {
  if (
    report.check(
      'the gateway creates an Accounts v2 recipient account (AU)',
      accountId !== null,
      accountId ?? `${created.error.code}; ${stripeError(lastAnswer)}`,
    )
  ) {
    await checkLink(accountId);
    await checkRead(accountId);
    await checkSchedules(accountId);
  }
} finally {
  if (accountId !== null) await remove(accountId);
  report.finish();
}

/** The hosted onboarding page, through the gateway (the URL itself is not printed). */
async function checkLink(accountId) {
  const link = await gateway.createAccountLink({
    accountRef: accountId,
    kind: 'onboarding',
    returnUrl: 'https://example.com/stripe-test/return',
    refreshUrl: 'https://example.com/stripe-test/refresh',
  });
  report.check(
    'the gateway opens an onboarding page',
    link.ok,
    link.ok ? 'connect.stripe.com URL' : `${link.error.code}; ${stripeError(lastAnswer)}`,
  );
}

/** The v1 read the webhook and the sync job use, on an Accounts v2 account. */
async function checkRead(accountId) {
  const read = await gateway.readAccount(accountId);
  report.check(
    'the gateway reads the account (v1 view)',
    read.ok && read.value.metadataMarketId === 'AU',
    read.ok
      ? `transfersActive ${read.value.transfersActive}, payoutsEnabled ${read.value.payoutsEnabled}, due ${read.value.requirementsDue}`
      : `${read.error.code}; ${stripeError(lastAnswer)}`,
  );
}

/** Test accounts are removed: v1 delete, or the v2 close when v1 refuses an Accounts v2 account. */
async function remove(accountId) {
  const removed = await stripe(key, 'DELETE', `/v1/accounts/${accountId}`);
  if (removed.status === 200) {
    report.pass('delete the test account', accountId);
    return;
  }
  const closed = await fetch(`https://api.stripe.com/v2/core/accounts/${accountId}/close`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Stripe-Version': STRIPE_V2_VERSION,
    },
    body: JSON.stringify({ applied_configurations: ['recipient'] }),
    signal: AbortSignal.timeout(15_000),
  });
  report.check(
    'close the test account',
    closed.status === 200,
    closed.status === 200
      ? `${accountId} (v1 delete: ${stripeError(removed)})`
      : stripeError({ status: closed.status, body: await closed.json().catch(() => ({})) }),
  );
}

/** Manual, back to daily, manual again: each set through the gateway, then read back. */
async function checkSchedules(accountId) {
  let step = 0;
  for (const interval of ['manual', 'daily', 'manual']) {
    step += 1;
    const set = await gateway.setPayoutSchedule(accountId, interval, `f3-${run}-${step}`);
    if (!set.ok) {
      report.fail(
        `platform sets the schedule to ${interval}`,
        `${set.error.code}; ${stripeError(lastAnswer)}`,
      );
      continue;
    }
    report.pass(`platform sets the schedule to ${interval}`);
    const read = await gateway.readAccount(accountId);
    report.check(
      `Stripe reports ${interval} on a re-read`,
      read.ok && read.value.payoutScheduleInterval === interval,
      read.ok ? `interval ${read.value.payoutScheduleInterval}` : read.error.code,
    );
  }

  const balance = await fetch('https://api.stripe.com/v1/balance_settings', {
    headers: { Authorization: `Bearer ${key}`, 'Stripe-Account': accountId },
    signal: AbortSignal.timeout(15_000),
  });
  const settings = await balance.json().catch(() => ({}));
  report.check(
    'Balance Settings reports the schedule',
    balance.status === 200,
    balance.status === 200
      ? `interval ${settings.payments?.payouts?.schedule?.interval ?? 'unset'}`
      : stripeError({ status: balance.status, body: settings }),
  );

  const account = await stripe(key, 'GET', `/v1/accounts/${accountId}`);
  const controller = account.body?.controller ?? {};
  report.check(
    'record the controller settings',
    account.status === 200,
    [
      `controller.type ${controller.type ?? 'unset'}`,
      `stripe_dashboard ${controller.stripe_dashboard?.type ?? 'unset'}`,
      `requirement_collection ${controller.requirement_collection ?? 'unset'}`,
      `fees.payer ${controller.fees?.payer ?? 'unset'}`,
    ].join(', '),
  );
}
