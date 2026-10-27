// F-3 (handoff phase5-connected-accounts, gate before package 6c transfers): in Stripe test
// mode, the platform can set a connected Express account's payout schedule to manual and back
// through the gateway the API ships (job payments.sync-payout-schedules), and Stripe reports the
// new interval when the account is read again. The account's controller settings are recorded
// too: they decide whether the seller can change the schedule from the Express Dashboard.
//
// Creates one throwaway test Express account and deletes it at the end. Needs the built API
// (pnpm build). Prints ids and results only, never the key.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test/f3-payout-schedule.mjs
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Report, stripe, stripeError, testKey } from './stripe-test-kit.mjs';

const require = createRequire(path.resolve('apps/api/package.json'));
const {
  StripeConnectGateway,
} = require('./dist/modules/payments/infrastructure/stripe-connect-gateway.js');

const key = testKey();
const gateway = new StripeConnectGateway(key);
const report = new Report('F-3: platform sets an Express payout schedule (Stripe test mode)');
const run = randomUUID();

const created = await stripe(key, 'POST', '/v1/accounts', {
  type: 'express',
  country: 'AU',
  'capabilities[transfers][requested]': 'true',
  'metadata[market_id]': 'AU',
  'metadata[seller_id]': run,
  'metadata[purpose]': 'f3-check',
});
const accountId = created.status === 200 ? created.body.id : null;

try {
  if (
    report.check(
      'create a test Express account (AU)',
      accountId !== null,
      accountId ?? stripeError(created),
    )
  ) {
    await checkSchedules(accountId);
  }
} finally {
  if (accountId !== null) {
    const removed = await stripe(key, 'DELETE', `/v1/accounts/${accountId}`);
    report.check(
      'delete the test account',
      removed.status === 200,
      removed.status === 200 ? accountId : stripeError(removed),
    );
  }
  report.finish();
}

/** Manual, back to daily, manual again: each set through the gateway, then read back. */
async function checkSchedules(accountId) {
  let step = 0;
  for (const interval of ['manual', 'daily', 'manual']) {
    step += 1;
    const set = await gateway.setPayoutSchedule(accountId, interval, `f3-${run}-${step}`);
    if (!set.ok) {
      // The gateway answers with a code only; the same update sent raw shows Stripe's reason.
      const raw = await stripe(key, 'POST', `/v1/accounts/${accountId}`, {
        'settings[payouts][schedule][interval]': interval,
      });
      report.fail(
        `platform sets the schedule to ${interval}`,
        `${set.error.code}; ${stripeError(raw)}`,
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
