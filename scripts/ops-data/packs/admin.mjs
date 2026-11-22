// Pack "admin": the two platform admins every other pack signs in as. The first admin is invited
// with the API's own operator command (identity-admin first-admin), the second, the reviewer who
// approves what waits for a second admin (System requests, maker-checker), with identity-admin
// second-admin; each invitation is read from Mailpit and accepted with a TOTP second factor, like a
// person would in the admin panel.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../guard.mjs';
import { Session, adminSignIn, mailLink, totp } from '../lib.mjs';
import { LOCAL } from '../state.mjs';

function operatorInvitation(command, market, email) {
  const entry = resolve(ROOT, 'apps/api/dist/identity-admin.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api/dist/identity-admin.js is missing: build the API first (pnpm --filter @mondapac/api build)',
    );
  }
  // The API refuses to start with the migration role's URL in its environment.
  const env = { ...process.env };
  delete env.MIGRATION_DATABASE_URL;
  const run = spawnSync(process.execPath, [entry, command, '--market', market, '--email', email], {
    env: {
      MARKET_CONFIG_DIR: resolve(LOCAL, 'markets'),
      SERVICE_AREA_CONFIG_DIR: resolve(LOCAL, 'service-areas'),
      ...env,
      APP_ROLE: 'api',
    },
    encoding: 'utf8',
  });
  const out = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status === 0) return 'issued';
  if (run.status === 2) return out.includes('first-admin.exists') ? 'exists' : `declined: ${out}`;
  throw new Error(
    `${command} failed (exit ${run.status}): ${run.stderr.split('\n').slice(-4).join(' | ')}`,
  );
}

/**
 * Ensures one admin exists (`key` admin or reviewer in the state); answers a signed-in session.
 * The operator command issues the invitation; the loader accepts it from Mailpit.
 */
async function ensureAdmin({ key, command, person, market, state, save, password, log }) {
  const { email, displayName } = person;
  if (state[key]?.accepted) {
    try {
      return await adminSignIn(email, password, state[key].secret, market);
    } catch (error) {
      throw new Error(
        `${key} sign-in failed (${error.message}). If the database was rebuilt, the state file is ` +
          'stale: delete .local/ops-data/ and run the loader again.',
        { cause: error },
      );
    }
  }
  let enrolment = state[key]?.enrolment;
  let token;
  if (enrolment === undefined) {
    const since = Date.now() - 2000;
    const outcome = operatorInvitation(command, market, email);
    if (outcome === 'exists') {
      throw new Error(
        'The database already has an admin that the loader did not create, so its authenticator ' +
          'secret is unknown. Rebuild the database and run the loader again.',
      );
    }
    if (outcome !== 'issued') throw new Error(`${command}: ${outcome}`);
    token = await mailLink(email, /#(mi1_\S+)/, { since });
    enrolment = await new Session('admin', market).ok(
      'POST',
      '/identity/admin/invitation/enrolment',
      { token },
    );
    // Saved before accepting, so a run that dies in between can finish on the next run.
    state[key] = { email, enrolment, accepted: false };
    save();
  } else {
    token = await mailLink(email, /#(mi1_\S+)/);
  }
  await new Session('admin', market).ok('POST', '/identity/admin/invitation/accept', {
    token,
    displayName,
    password,
    secret: enrolment.secret,
    tag: enrolment.tag,
    expiresAt: enrolment.expiresAt,
    code: totp(enrolment.secret),
  });
  state[key] = { email, secret: enrolment.secret, accepted: true };
  save();
  log(`  ${key} ${email} created`);
  return adminSignIn(email, password, enrolment.secret, market);
}

/** Ensures both admins exist; answers `{ admin, reviewer }`, two signed-in sessions. */
export async function adminPack({ scenario, state, save, password, log }) {
  const common = { market: scenario.market, state, save, password, log };
  const admin = await ensureAdmin({
    key: 'admin',
    command: 'first-admin',
    person: scenario.admin,
    ...common,
  });
  const reviewer = await ensureAdmin({
    key: 'reviewer',
    command: 'second-admin',
    person: scenario.reviewer,
    ...common,
  });
  return { admin, reviewer };
}
