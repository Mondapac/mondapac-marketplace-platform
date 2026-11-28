// Pack "sellers": the scenario's sellers through the seller panel and the admin panel, as people
// would: sign-up and email confirmation, the seller file (general, address and zone, store
// address, ABN), submit, and the admin's review (register check, then approve or reject). An
// approved store gets its About text, logo and minimum order, and its stock location's address.
// Sellers in the other states stop where the scenario says: in review, rejected, suspended after
// approval, or a draft file never submitted. A rerun creates only what is missing.
import { Session, mailLink, setMainActivity, sleep } from '../lib.mjs';
import { logo } from '../media.mjs';
import { settle, write } from './requests.mjs';

async function waitFor(label, check, seconds) {
  for (let waited = 0; waited < seconds; waited += 1) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not happen within ${seconds} s (is the worker running?)`);
}

export async function sellerSignIn(seller, password, market) {
  const session = new Session('seller', market);
  const answer = await session.request('POST', '/identity/seller/sign-in', {
    email: seller.email,
    password,
  });
  return answer.status === 200 ? { session, access: answer.body.sellerAccess } : null;
}

/** Every row of an admin seller-list tab, page by page. */
async function sellerRows(admin, tab) {
  const rows = [];
  let after;
  do {
    const page = await admin.ok('POST', '/sellers/admin/list', { tab, after });
    rows.push(...page.items);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return rows;
}

async function signedUp(seller, password, market) {
  const found = await sellerSignIn(seller, password, market);
  if (found !== null) return found;
  const since = Date.now() - 2000;
  const anonymous = new Session('seller', market);
  await anonymous.ok('POST', '/identity/seller/sign-up', {
    displayName: seller.owner,
    email: seller.email,
    password,
  });
  const token = await mailLink(seller.email, /#(ml1_\S+)/, { since });
  await anonymous.okLink('POST', '/identity/seller/confirm-email', { token, password });
  const again = await sellerSignIn(seller, password, market);
  if (again === null) throw new Error(`${seller.key}: cannot sign in after confirming the email`);
  return again;
}

async function fillFile(session, seller, scenario) {
  await waitFor(
    `${seller.key}: the seller file`,
    async () => (await session.get('/sellers/my-file')).status === 200,
    60,
  );
  await session.ok('PUT', '/sellers/my-file/general', {
    storeName: seller.storeName,
    businessName: seller.businessName,
    phone: seller.phone,
  });
  if (seller.state === 'draft') return;
  await session.ok('PUT', '/sellers/my-file/address', {
    address: seller.address,
    timezone: scenario.timeZone,
  });
  await session.ok('PUT', '/sellers/my-file/slug', { slug: seller.slug });
  await session.ok('PUT', '/sellers/my-file/identifier', { identifier: seller.abn });
  const submitted = await session.post('/sellers/my-file/submit', {});
  if (submitted.status !== 200 && submitted.body?.code !== 'file.already-submitted') {
    throw new Error(
      `${seller.key}: submit -> ${submitted.status} ${JSON.stringify(submitted.body)}`,
    );
  }
}

/** The admin's decision on a submitted file: approve (after the register check) or reject. */
async function decide(admin, reviewer, seller, scenario, state, log) {
  const waiting = await sellerRows(admin, 'awaiting-review');
  const row = waiting.find((item) => item.slug === seller.slug);
  if (!row) throw new Error(`${seller.key}: not in the awaiting-review list`);
  const review = await admin.ok('GET', `/sellers/admin/${row.sellerId}/review`);
  const revisionId = review.current.id;
  const pending = [];
  if (seller.state === 'rejected') {
    await write(
      admin,
      'POST',
      `/sellers/admin/${row.sellerId}/review/reject`,
      { revisionId, reason: seller.rejection },
      pending,
      `reject ${seller.key}`,
    );
  } else {
    await setMainActivity(admin, state.admin.secret, row.sellerId, scenario.locale);
    await admin.ok('PUT', `/sellers/admin/${row.sellerId}/review/manual-register-check`, {
      revisionId,
      observedOutcome: 'active',
    });
    await write(
      admin,
      'POST',
      `/sellers/admin/${row.sellerId}/review/approve`,
      { revisionId },
      pending,
      `approve ${seller.key}`,
    );
  }
  await settle(reviewer, pending, log);
  return row.sellerId;
}

/** The public store: About text, logo, minimum order and the stock location's address. */
async function dressStore(session, seller, scenario) {
  const profile = await session.ok('GET', '/sellers/store-profile');
  if (profile.logo === null || profile.about?.[scenario.locale] !== seller.about) {
    await session.ok('PUT', '/sellers/store-profile', {
      expectedVersion: profile.version,
      about: { [scenario.locale]: seller.about },
      ...(profile.logo === null
        ? { logo: { data: await logo(seller.storeName, seller.colour) } }
        : {}),
    });
  }
  if (seller.minimum !== null) {
    const settings = await session.ok('GET', '/sellers/store-settings');
    if (settings.minimumOrder?.amount !== seller.minimum) {
      await session.ok('PUT', '/sellers/store-settings/minimum-order', {
        expectedVersion: settings.version,
        minimumOrder: { amount: seller.minimum, currency: settings.currency },
      });
    }
  }
  // Inventory makes the seller's default stock location from the approval event; wait for it.
  let sources = null;
  await waitFor(
    `${seller.key}: the stock location`,
    async () => {
      const answer = await session.get('/inventory/seller/sources');
      if (answer.status === 200) sources = answer.body;
      return sources !== null;
    },
    60,
  );
  const source = sources.sources.find((item) => item.isDefault) ?? sources.sources[0];
  if (source.address === null) {
    await session.ok('PUT', `/inventory/seller/sources/${source.id}`, {
      expectedVersion: sources.version,
      name: seller.stockName,
      address: seller.address,
      timeZone: scenario.timeZone,
    });
  }
}

async function suspend(admin, reviewer, sellerId, seller, log) {
  const pending = [];
  await write(
    admin,
    'POST',
    `/identity/admin/sellers/${sellerId}/suspend`,
    { reason: seller.suspension },
    pending,
    `suspend ${seller.key}`,
  );
  await settle(reviewer, pending, log);
}

/**
 * Builds every seller of the scenario; returns the signed-in sessions of the approved ones by
 * key (the products pack lists their offers). State: state.sellers[key] = { sellerId, state }.
 */
export async function sellersPack({ admin, reviewer, scenario, state, save, password, log }) {
  const market = scenario.market;
  state.sellers ??= {};
  const sessions = new Map();
  const counts = {};
  for (const seller of scenario.sellers) {
    const done = state.sellers[seller.key];
    counts[seller.state] = (counts[seller.state] ?? 0) + 1;
    if (done?.state === seller.state && seller.state !== 'approved') continue;
    let { session, access } = await signedUp(seller, password, market);
    if (access !== 'approved') {
      if (done === undefined || done.state === 'signed-up') {
        await fillFile(session, seller, scenario);
        state.sellers[seller.key] = { sellerId: null, state: 'signed-up' };
        save();
      }
      if (seller.state === 'draft' || seller.state === 'in-review') {
        state.sellers[seller.key] = { sellerId: null, state: seller.state };
        save();
        continue;
      }
      const sellerId = await decide(admin, reviewer, seller, scenario, state, log);
      state.sellers[seller.key] = {
        sellerId,
        state: seller.state === 'rejected' ? 'rejected' : 'approving',
      };
      save();
      if (seller.state === 'rejected') continue;
      // The approval reaches identity through an event; wait for the seller's access to follow.
      await waitFor(
        `${seller.key}: seller access approved`,
        async () => {
          const again = await sellerSignIn(seller, password, market);
          if (again?.access !== 'approved') return false;
          session = again.session;
          return true;
        },
        90,
      );
    }
    await dressStore(session, seller, scenario);
    const sellerId =
      state.sellers[seller.key]?.sellerId ??
      (await sellerRows(admin, 'approved')).find((item) => item.slug === seller.slug).sellerId;
    if (seller.state === 'suspended') {
      await suspend(admin, reviewer, sellerId, seller, log);
      state.sellers[seller.key] = { sellerId, state: 'suspended' };
      save();
      continue;
    }
    state.sellers[seller.key] = { sellerId, state: 'approved' };
    save();
    sessions.set(seller.key, session);
  }
  log(
    `  ${scenario.sellers.length} sellers (${Object.entries(counts)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ')})`,
  );
  return sessions;
}
