// Pack "admin": the platform admin every other pack signs in as. The first admin is invited with
// the API's own command (identity-admin first-admin), the invitation is read from Mailpit and
// accepted with a TOTP second factor, like a person would in the admin panel.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../guard.mjs';
import { Session, adminSignIn, mailLink, totp } from '../lib.mjs';
import { LOCAL } from '../state.mjs';

function firstAdminInvitation(market, email) {
  const entry = resolve(ROOT, 'apps/api/dist/identity-admin.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api/dist/identity-admin.js is missing: build the API first (pnpm --filter @mondapac/api build)',
    );
  }
  // The API refuses to start with the migration role's URL in its environment.
  const env = { ...process.env };
  delete env.MIGRATION_DATABASE_URL;
  const run = spawnSync(
    process.execPath,
    [entry, 'first-admin', '--market', market, '--email', email],
    {
      env: {
        MARKET_CONFIG_DIR: resolve(LOCAL, 'markets'),
        SERVICE_AREA_CONFIG_DIR: resolve(LOCAL, 'service-areas'),
        ...env,
        APP_ROLE: 'api',
      },
      encoding: 'utf8',
    },
  );
  const out = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status === 0) return 'issued';
  if (run.status === 2) return out.includes('first-admin.exists') ? 'exists' : `declined: ${out}`;
  throw new Error(
    `first-admin failed (exit ${run.status}): ${run.stderr.split('\n').slice(-4).join(' | ')}`,
  );
}

/** Ensures the admin exists; answers a signed-in admin session. */
export async function adminPack({ scenario, state, save, password, log }) {
  const { market } = scenario;
  const { email, displayName } = scenario.admin;
  if (state.admin?.accepted) {
    try {
      return await adminSignIn(email, password, state.admin.secret, market);
    } catch (error) {
      throw new Error(
        `Admin sign-in failed (${error.message}). If the database was rebuilt, the state file is ` +
          'stale: delete .local/ops-data/ and run the loader again.',
        { cause: error },
      );
    }
  }
  let enrolment = state.admin?.enrolment;
  let token;
  if (enrolment === undefined) {
    const since = Date.now() - 2000;
    const outcome = firstAdminInvitation(market, email);
    if (outcome === 'exists') {
      throw new Error(
        'The database already has an admin that the loader did not create, so its authenticator ' +
          'secret is unknown. Rebuild the database and run the loader again.',
      );
    }
    if (outcome !== 'issued') throw new Error(`first-admin: ${outcome}`);
    token = await mailLink(email, /#(mi1_\S+)/, { since });
    enrolment = await new Session('admin', market).ok(
      'POST',
      '/identity/admin/invitation/enrolment',
      { token },
    );
    // Saved before accepting, so a run that dies in between can finish on the next run.
    state.admin = { email, enrolment, accepted: false };
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
  state.admin = { email, secret: enrolment.secret, accepted: true };
  save();
  log(`  admin ${email} created`);
  return adminSignIn(email, password, enrolment.secret, market);
}
