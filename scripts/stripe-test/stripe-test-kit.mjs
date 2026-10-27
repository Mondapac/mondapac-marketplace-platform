// Shared by the Stripe test-mode checks (.github/workflows/stripe-test.yml): the test key, a raw
// Stripe REST call, and the result table. The key is read from STRIPE_SECRET_KEY, must be a
// test-mode key, and is never printed. Stripe's error type, code and message are printed on a
// failure: they never carry the key.
import { appendFileSync } from 'node:fs';

const STRIPE_API = 'https://api.stripe.com';
const TIMEOUT_MS = 15_000;

/** The test-mode secret key, or exit: a live key or none is refused before any call. */
export function testKey() {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!/^(sk|rk)_test_[A-Za-z0-9_]{8,200}$/.test(key)) {
    console.error('STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_ or rk_test_).');
    process.exit(1);
  }
  return key;
}

/** One Stripe call: `{ status, body }`, never thrown on an HTTP error. */
export async function stripe(key, method, path, form = null) {
  const headers = { Authorization: `Bearer ${key}` };
  if (form !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    ...(form === null ? {} : { body: new URLSearchParams(form).toString() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json() };
}

/** Stripe's error, without anything else of the answer. */
export function stripeError(answer) {
  const error = answer?.body?.error ?? {};
  return `HTTP ${answer?.status}: ${error.type ?? '?'} ${error.code ?? ''} ${error.message ?? ''}`.trim();
}

/** Collects named checks and writes them to the log and the job summary. */
export class Report {
  #title;
  #rows = [];

  constructor(title) {
    this.#title = title;
  }

  pass(name, detail = '') {
    this.#rows.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  }

  fail(name, detail = '') {
    this.#rows.push({ name, ok: false, detail });
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }

  check(name, condition, detail = '') {
    if (condition) this.pass(name, detail);
    else this.fail(name, detail);
    return condition;
  }

  get failed() {
    return this.#rows.some((row) => !row.ok);
  }

  /** Writes the table to the job summary (when there is one) and sets the exit code. */
  finish() {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      const lines = [
        `### ${this.#title}`,
        '',
        '| Check | Result | Detail |',
        '| --- | --- | --- |',
      ];
      for (const row of this.#rows) {
        const detail = row.detail.replaceAll('|', '\\|');
        lines.push(`| ${row.name} | ${row.ok ? 'pass' : 'FAIL'} | ${detail} |`);
      }
      appendFileSync(summary, `${lines.join('\n')}\n\n`);
    }
    process.exitCode = this.failed ? 1 : 0;
  }
}
