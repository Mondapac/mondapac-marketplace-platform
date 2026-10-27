// Makes sure the Stripe account has the payment method configuration hosted Checkout uses: cards,
// with Apple Pay and Google Pay, and nothing else (ordering's StripeCheckoutGateway; Stripe no
// longer takes payment_method_types on a Checkout Session). Idempotent: finds the configuration by
// its name, creates it when missing, switches every other payment method of the account off, and
// reads it back. Prints the configuration id (pmc_, not a secret) for
// STRIPE_PAYMENT_METHOD_CONFIGURATION, and appends it to $GITHUB_ENV when that is set.
//
// Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test/ensure-card-only-config.mjs
import { appendFileSync } from 'node:fs';
import { Report, stripe, stripeError, testKey } from './stripe-test-kit.mjs';

const NAME = 'Mondapac checkout: cards only';
const ALLOWED = new Set(['card', 'apple_pay', 'google_pay']);

const key = testKey();
const report = new Report('Card-only payment method configuration (Stripe test mode)');

try {
  const id = await ensure();
  if (id !== null) {
    console.log(`STRIPE_PAYMENT_METHOD_CONFIGURATION=${id}`);
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `STRIPE_PAYMENT_METHOD_CONFIGURATION=${id}\n`);
    }
  }
} finally {
  report.finish();
}

async function ensure() {
  const list = await stripe(key, 'GET', '/v1/payment_method_configurations?limit=100');
  if (!report.check('list the configurations', list.status === 200, stripeError(list))) return null;
  const configurations = list.body.data ?? [];
  const reference = configurations.find((item) => item.is_default) ?? configurations[0];
  // Every payment method the account knows, as the configurations list them.
  const methods = Object.keys(reference ?? {}).filter(
    (name) => typeof reference[name]?.display_preference === 'object',
  );
  if (!report.check('know the account payment methods', methods.includes('card'))) return null;

  const form = { name: NAME };
  for (const method of methods) {
    form[`${method}[display_preference][preference]`] = ALLOWED.has(method) ? 'on' : 'off';
  }
  const existing = configurations.find((item) => item.name === NAME && !item.is_default);
  const saved = existing
    ? await stripe(key, 'POST', `/v1/payment_method_configurations/${existing.id}`, form)
    : await stripe(key, 'POST', '/v1/payment_method_configurations', form);
  if (
    !report.check(
      existing ? 'update the configuration' : 'create the configuration',
      saved.status === 200,
      saved.status === 200 ? saved.body.id : stripeError(saved),
    )
  ) {
    return null;
  }

  const read = await stripe(key, 'GET', `/v1/payment_method_configurations/${saved.body.id}`);
  // Every method the saved configuration lists, not only the ones the default listed: a method
  // that appears only here must be off too.
  const on = Object.keys(read.body ?? {}).filter(
    (method) => read.body[method]?.display_preference?.value === 'on',
  );
  report.check(
    'only cards and wallets are on',
    read.status === 200 && on.includes('card') && on.every((method) => ALLOWED.has(method)),
    `on: ${on.join(', ') || 'none'}`,
  );
  return report.failed ? null : saved.body.id;
}
