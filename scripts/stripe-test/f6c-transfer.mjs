// Package 6c go-live check: in Stripe test mode, one transfer from the platform balance to an
// onboarded Accounts v2 recipient account, sent through the transfer gateway the API ships
// (StripeTransferApiGateway, the 6c code path), then read back, looked up by its group, sent
// again under the same key and reversed. The transfer events Stripe writes are recorded for
// the webhook endpoint lists.
//
// The recipient account is onboarded through the API with Stripe's test identity values. A
// seller's real account (Express Dashboard, Stripe collects requirements) can only be onboarded
// in Stripe's hosted pages, so this account is created with no Dashboard and the platform
// collecting requirements; the transfer call does not depend on the Dashboard type, only on
// `stripe_transfers` being active. The account is closed at the end.
//
// Needs the built API (pnpm build). Prints ids and results only, never the key.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test/f6c-transfer.mjs
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Report, stripe, stripeError, testKey } from './stripe-test-kit.mjs';

const require = createRequire(path.resolve('apps/api/package.json'));
const {
  STRIPE_V2_VERSION,
  StripeConnectGateway,
} = require('./dist/modules/payments/infrastructure/stripe-connect-gateway.js');
const {
  StripeTransferApiGateway,
} = require('./dist/modules/payments/infrastructure/stripe-transfer-gateway.js');

const key = testKey();
const report = new Report(
  '6c: one transfer to an onboarded Accounts v2 account (Stripe test mode)',
);
const run = randomUUID();
const startedAt = Math.floor(Date.now() / 1000);
const AMOUNT_MINOR = 500;
const FUNDING_MINOR = 2000;
const CURRENCY = 'AUD';

const transfers = new StripeTransferApiGateway(key);
const connect = new StripeConnectGateway(key);

let accountId = null;
try {
  if (await fund()) {
    accountId = await createRecipient();
    if (accountId !== null && (await waitForTransfers(accountId))) {
      await checkV1View(accountId);
      await checkTransfer(accountId);
    }
  }
} finally {
  if (accountId !== null) await close(accountId);
  report.finish();
}

/** One v2 call (JSON, pinned version): `{ status, body }`. */
async function v2(method, apiPath, json = null) {
  const response = await fetch(`https://api.stripe.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_V2_VERSION,
      ...(json === null ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(json === null ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A test card payment that skips the pending balance, so the platform can transfer at once. */
async function fund() {
  const form = {
    amount: String(FUNDING_MINOR),
    currency: CURRENCY.toLowerCase(),
    payment_method: 'pm_card_bypassPending',
    confirm: 'true',
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
    description: `6c transfer check ${run}`,
  };
  // The card-only configuration of the earlier step, when this job set it.
  const configuration = process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION;
  if (configuration) form.payment_method_configuration = configuration;
  const paid = await stripe(key, 'POST', '/v1/payment_intents', form);
  if (
    !report.check(
      'fund the platform test balance (bypass-pending test card)',
      paid.status === 200 && paid.body.status === 'succeeded',
      paid.status === 200 ? `${paid.body.id} ${paid.body.status}` : stripeError(paid),
    )
  ) {
    return false;
  }
  const balance = await stripe(key, 'GET', '/v1/balance');
  const available = (balance.body.available ?? []).find(
    (entry) => entry.currency === CURRENCY.toLowerCase(),
  );
  return report.check(
    'the platform has an available balance to transfer',
    balance.status === 200 && (available?.amount ?? 0) >= AMOUNT_MINOR,
    balance.status === 200
      ? `available ${available?.amount ?? 0} ${CURRENCY}`
      : stripeError(balance),
  );
}

/** Accounts v2 recipient, onboarded with Stripe's test identity values (no real person). */
async function createRecipient() {
  const created = await v2('POST', '/v2/core/accounts', {
    contact_email: `f6c-${run.slice(0, 8)}@example.com`,
    display_name: '6c transfer check',
    dashboard: 'none',
    identity: {
      country: 'AU',
      entity_type: 'individual',
      attestations: {
        terms_of_service: {
          account: { date: new Date().toISOString(), ip: '203.0.113.10' },
        },
      },
      individual: {
        given_name: 'Test',
        surname: 'Recipient',
        email: `f6c-${run.slice(0, 8)}@example.com`,
        phone: '+61400000000',
        date_of_birth: { day: 1, month: 1, year: 1901 },
        address: {
          line1: 'address_full_match',
          city: 'Brisbane',
          state: 'QLD',
          postal_code: '4000',
          country: 'AU',
        },
      },
    },
    defaults: {
      currency: CURRENCY.toLowerCase(),
      responsibilities: { fees_collector: 'application', losses_collector: 'application' },
    },
    configuration: {
      recipient: {
        capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
      },
    },
    metadata: { market_id: 'AU', purpose: '6c-transfer-check' },
  });
  const id = typeof created.body.id === 'string' ? created.body.id : null;
  report.check(
    'create an Accounts v2 recipient with test identity values (AU)',
    created.status === 200 && id !== null,
    id ?? stripeError(created),
  );
  return id;
}

/** `stripe_transfers` active on the v2 account; the open requirements are shown when it is not. */
async function waitForTransfers(id) {
  const query = '?include=configuration.recipient&include=requirements&include=identity';
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await v2('GET', `/v2/core/accounts/${id}${query}`);
    const status =
      last.body?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
    if (status === 'active') {
      report.pass('stripe_transfers is active on the v2 account', `after ${attempt * 5} s`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const capability =
    last?.body?.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers ?? {};
  // Requirement names and reasons only: the values are this run's test data.
  const due = (last?.body?.requirements?.entries ?? [])
    .map((entry) => `${entry.description ?? '?'} (${entry.minimum_deadline?.status ?? ''})`)
    .join(', ');
  report.fail(
    'stripe_transfers is active on the v2 account',
    last?.status === 200
      ? `status ${capability.status ?? 'unset'}; reasons ${JSON.stringify(capability.status_details ?? [])}; due: ${due || 'none'}`
      : stripeError(last),
  );
  return false;
}

/** HP-1 (c): the v1 read the API uses reports `transfers` active on the onboarded v2 account. */
async function checkV1View(id) {
  const read = await connect.readAccount(id);
  report.check(
    'the connect gateway reads transfers active (v1 view of the v2 account)',
    read.ok && read.value.transfersActive === true,
    read.ok
      ? `transfersActive ${read.value.transfersActive}, payoutsEnabled ${read.value.payoutsEnabled}`
      : read.error.code,
  );
}

/** The 6c gateway: create, same key again, read, group lookup, reverse, events. */
async function checkTransfer(destination) {
  const payoutId = randomUUID();
  const request = {
    destination,
    amountMinor: BigInt(AMOUNT_MINOR),
    currency: CURRENCY,
    transferGroup: payoutId,
    key: `f6c-check:${payoutId}`,
    payoutId,
    marketId: 'AU',
  };
  const created = await transfers.createTransfer(request);
  if (
    !report.check(
      'the transfer gateway creates the transfer',
      created.kind === 'created',
      created.kind === 'created' ? created.ref : `${created.kind} ${created.code ?? ''}`,
    )
  ) {
    return;
  }
  const transferId = created.ref;

  const again = await transfers.createTransfer(request);
  report.check(
    'the same key again returns the same transfer (idempotency)',
    again.kind === 'created' && again.ref === transferId,
    again.kind === 'created' ? again.ref : `${again.kind} ${again.code ?? ''}`,
  );

  const read = await transfers.readTransfer(transferId);
  report.check(
    'read back: amount, currency, destination, key, Market, test mode',
    read.ok &&
      read.value.amountMinor === BigInt(AMOUNT_MINOR) &&
      read.value.currency === CURRENCY.toLowerCase() &&
      read.value.destination === destination &&
      read.value.key === request.key &&
      read.value.marketId === 'AU' &&
      read.value.livemode === false,
    read.ok
      ? `${read.value.amountMinor} ${read.value.currency} to ${read.value.destination}, livemode ${read.value.livemode}`
      : read.error.code,
  );

  const group = await transfers.listTransfersByGroup(payoutId);
  report.check(
    'lookup by transfer group finds exactly this transfer',
    group.ok && group.value.length === 1 && group.value[0].id === transferId,
    group.ok ? `${group.value.length} found` : group.error.code,
  );

  const reversed = await stripe(key, 'POST', `/v1/transfers/${transferId}/reversals`, {
    'metadata[purpose]': '6c-transfer-check',
  });
  report.check(
    'reverse the test transfer',
    reversed.status === 200,
    reversed.status === 200 ? reversed.body.id : stripeError(reversed),
  );
  const after = await transfers.readTransfer(transferId);
  report.check(
    'read back after the reversal: amount reversed',
    after.ok && after.value.amountReversedMinor === BigInt(AMOUNT_MINOR),
    after.ok ? `reversed ${after.value.amountReversedMinor}` : after.error.code,
  );

  await recordEvents(transferId);
}

/** Which events Stripe wrote for this transfer, on the platform (recorded, not asserted). */
async function recordEvents(transferId) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const answer = await stripe(key, 'GET', `/v1/events?limit=100&created[gte]=${startedAt - 5}`);
  if (answer.status !== 200) {
    report.fail('record the platform events of the transfer', stripeError(answer));
    return;
  }
  const counts = {};
  for (const event of answer.body.data ?? []) {
    const object = event.data?.object ?? {};
    const mine = object.id === transferId || object.transfer === transferId;
    if (mine) counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  report.pass(
    'record the platform events of the transfer',
    Object.entries(counts)
      .map(([type, n]) => `${type} x${n}`)
      .join(', ') || 'none',
  );
}

/** The test account is closed: v2 close, or v1 delete when the close is refused. */
async function close(id) {
  const closed = await v2('POST', `/v2/core/accounts/${id}/close`, {
    applied_configurations: ['recipient'],
  });
  if (closed.status === 200) {
    report.pass('close the test account', id);
    return;
  }
  const removed = await stripe(key, 'DELETE', `/v1/accounts/${id}`);
  report.check(
    'close the test account',
    removed.status === 200,
    removed.status === 200 ? `${id} (v2 close: ${stripeError(closed)})` : stripeError(removed),
  );
}
